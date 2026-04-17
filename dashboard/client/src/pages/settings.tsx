import { useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  apiRequest,
  logoutUserSession,
  queryClient,
  provisionDashboardApiKey,
  getStoredApiKey,
} from '@/lib/queryClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Power, ShieldCheckered, AlertTriangle, Server, KeyRound, Copy, TerminalSquare, SlidersHorizontal, Plus, Trash2, Target, Wallet } from "@/components/ui/icons";
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from '@/components/ui/empty-state';
import { AgentSettingsPanel } from "@/components/agent-settings-panel";
import { useToast } from '@/hooks/use-toast';
import type { Wallet as WalletType, KillSwitch } from '@shared/schema';

type EnforcementMode = 'off' | 'soft' | 'hard';

type BuyFilterBounds = {
  minMarketCapUsd?: number;
  maxMarketCapUsd?: number;
  minVolumeUsd24h?: number;
  maxVolumeUsd24h?: number;
  minLiquidityUsd?: number;
  maxLiquidityUsd?: number;
  minHolders?: number;
  maxHolders?: number;
  maxTop10ConcentrationPct?: number;
  maxDevHoldingPct?: number;
};

type TradingPolicy = {
  riskEnforcement: EnforcementMode;
  buyFilterEnforcement: EnforcementMode;
  buyFilters: BuyFilterBounds;
  alphaFilters: BuyFilterBounds;
  onePurchasePerToken: boolean;
  maxSlippageBps: number;
};

/** Mirrors `SYSTEM_WALLET_RISK_DEFAULTS` on the API — used only if GET fails. */
const SYSTEM_WALLET_RISK_DEFAULTS_UI = {
  tpExits: [
    { percent: 100, amountPct: 50 },
    { percent: 200, amountPct: 80 },
  ],
  slExits: [{ percent: 45, amountPct: 100 }],
  trailingStop: {
    levels: [
      { percentage: 25, amount: 50, triggerAboveATH: 100 },
      { percentage: 30, amount: 100, triggerAboveATH: 200 },
    ],
  },
} as const;

type RiskDefaultsShape = {
  tpExits: Array<{ percent: number; amountPct: number }>;
  slExits: Array<{ percent: number; amountPct: number }>;
  trailingStop: {
    levels: Array<{ percentage: number; amount: number; triggerAboveATH?: number }>;
  };
};

type RiskDefaultsApiResponse = {
  ok: boolean;
  walletId: string;
  source: 'user' | 'system';
  defaults: RiskDefaultsShape;
  updatedAt: string | null;
};

function cloneRiskDefaults(d: RiskDefaultsShape): RiskDefaultsShape {
  return JSON.parse(JSON.stringify(d)) as RiskDefaultsShape;
}

/** Clamp sell portion to 1–100%. */
function clampAmountPct(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(100, Math.max(1, n));
}

/** SL drawdown must be in (0, 100] — above 100% never triggers. */
function clampSlDrawdownPct(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(100, Math.max(0.0001, n));
}

/**
 * Validates wallet exit defaults. Trailing levels are not ordered (by design).
 * TP / SL: trigger % must be non-decreasing across levels.
 */
function validateWalletRiskDefaults(d: RiskDefaultsShape): string | null {
  const { tpExits, slExits, trailingStop } = d;
  if (!tpExits?.length || !slExits?.length || !trailingStop?.levels?.length) {
    return 'TP, SL, and trailing stop must each have at least one level.';
  }
  for (let i = 0; i < tpExits.length; i++) {
    const { percent, amountPct } = tpExits[i];
    if (!Number.isFinite(percent) || percent <= 0) return `Take profit level ${i + 1}: gain % must be a positive number.`;
    if (!Number.isFinite(amountPct) || amountPct < 1 || amountPct > 100) {
      return `Take profit level ${i + 1}: sell % must be between 1 and 100.`;
    }
  }
  for (let i = 1; i < tpExits.length; i++) {
    if (tpExits[i].percent < tpExits[i - 1].percent) {
      return `Take profit: level ${i + 1} gain % (${tpExits[i].percent}) cannot be lower than level ${i} (${tpExits[i - 1].percent}).`;
    }
  }
  for (let i = 0; i < slExits.length; i++) {
    const { percent, amountPct } = slExits[i];
    if (!Number.isFinite(percent) || percent <= 0) return `Stop loss level ${i + 1}: drawdown % must be a positive number.`;
    if (percent > 100) return `Stop loss level ${i + 1}: drawdown cannot exceed 100% (it would never trigger).`;
    if (!Number.isFinite(amountPct) || amountPct < 1 || amountPct > 100) {
      return `Stop loss level ${i + 1}: sell % must be between 1 and 100.`;
    }
  }
  for (let i = 1; i < slExits.length; i++) {
    if (slExits[i].percent < slExits[i - 1].percent) {
      return `Stop loss: level ${i + 1} drawdown % (${slExits[i].percent}) cannot be lower than level ${i} (${slExits[i - 1].percent}).`;
    }
  }
  for (let i = 0; i < trailingStop.levels.length; i++) {
    const lv = trailingStop.levels[i];
    if (!Number.isFinite(lv.percentage) || lv.percentage <= 0) return `Trailing level ${i + 1}: trail % must be positive.`;
    if (!Number.isFinite(lv.amount) || lv.amount < 1 || lv.amount > 100) {
      return `Trailing level ${i + 1}: amount % must be between 1 and 100.`;
    }
    const ath = lv.triggerAboveATH ?? 100;
    if (!Number.isFinite(ath) || ath <= 0) return `Trailing level ${i + 1}: ATH gate must be positive.`;
  }
  return null;
}

const ENFORCEMENT_LABELS: Record<EnforcementMode, { short: string; description: string; color: string }> = {
  off:  { short: 'Off',  description: 'Off — no enforcement',       color: 'text-muted-foreground' },
  soft: { short: 'Soft', description: 'Soft — warn only',           color: 'text-yellow-400' },
  hard: { short: 'Hard', description: 'Hard — block / override',    color: 'text-loss' },
};

function EnforcementSelect({ value, onChange, disabled }: { value: EnforcementMode; onChange: (v: EnforcementMode) => void; disabled?: boolean }) {
  const meta = ENFORCEMENT_LABELS[value] ?? ENFORCEMENT_LABELS.off;
  return (
    <Select value={value} onValueChange={(v) => onChange(v as EnforcementMode)} disabled={disabled}>
      <SelectTrigger className="text-xs h-8 w-44">
        <span className={`font-semibold ${meta.color}`}>{meta.short}</span>
      </SelectTrigger>
      <SelectContent>
        {(Object.entries(ENFORCEMENT_LABELS) as [EnforcementMode, typeof ENFORCEMENT_LABELS[EnforcementMode]][]).map(([k, m]) => (
          <SelectItem key={k} value={k}>
            <span className={`font-semibold ${m.color} mr-1`}>{m.short}</span>
            <span className="text-muted-foreground">{m.description.split('—')[1]?.trim()}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function FilterBoundsForm({
  label,
  bounds,
  onChange,
  disabled,
}: {
  label: string;
  bounds: BuyFilterBounds;
  onChange: (b: BuyFilterBounds) => void;
  disabled?: boolean;
}) {
  const fields: Array<{ key: keyof BuyFilterBounds; label: string; prefix?: string; suffix?: string }> = [
    { key: 'minMarketCapUsd', label: 'Min Market Cap', prefix: '$' },
    { key: 'maxMarketCapUsd', label: 'Max Market Cap', prefix: '$' },
    { key: 'minVolumeUsd24h', label: 'Min 24h Volume', prefix: '$' },
    { key: 'maxVolumeUsd24h', label: 'Max 24h Volume', prefix: '$' },
    { key: 'minLiquidityUsd', label: 'Min Liquidity', prefix: '$' },
    { key: 'maxLiquidityUsd', label: 'Max Liquidity', prefix: '$' },
    { key: 'minHolders', label: 'Min Holders' },
    { key: 'maxHolders', label: 'Max Holders' },
    { key: 'maxTop10ConcentrationPct', label: 'Max Top-10 Concentration', suffix: '%' },
    { key: 'maxDevHoldingPct', label: 'Max Dev Holding', suffix: '%' },
  ];
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {fields.map(({ key, label: fl, prefix, suffix }) => (
          <div key={key} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
            <span className="w-full shrink-0 text-xs text-muted-foreground sm:w-32">{fl}</span>
            <div className="relative w-full flex-1">
              {prefix && (
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{prefix}</span>
              )}
              <Input
                type="number"
                min={0}
                disabled={disabled}
                value={bounds[key] ?? ''}
                placeholder="—"
                className={`text-xs h-7 ${prefix ? 'pl-5' : ''} ${suffix ? 'pr-7' : ''}`}
                onChange={(e) => {
                  const raw = e.target.value;
                  onChange({
                    ...bounds,
                    [key]: raw === '' ? undefined : Number(raw),
                  });
                }}
              />
              {suffix && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{suffix}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const CLI_INSTALL_LINK_PLACEHOLDER = '#';

const DEFAULT_RISK_LIMITS = {
  maxSlippageBps: 2000,
};

export default function Settings() {
  const { toast } = useToast();
  const [policyDraft, setPolicyDraft] = useState<TradingPolicy | null>(null);

  const { data: wallets } = useQuery<WalletType[]>({
    queryKey: [
      '/api/wallets',
    ],
  });
  const wallet = wallets?.[0];

  const { data: killSwitch, isLoading: ksLoading } = useQuery<KillSwitch>({
    queryKey: [
      '/api/killswitch/status',
      wallet?.id ? `?walletId=${wallet.id}` : '',
    ],
    enabled: !!wallet?.id,
  });
  const killSwitchQueryKey = [
    '/api/killswitch/status',
    wallet?.id ? `?walletId=${wallet.id}` : '',
  ];
  const { data: capitalStatus } = useQuery<{
    limits?: Record<string, number>;
    solPriceUsd?: number;
  }>({
    queryKey: [
      '/api/capital/status',
      wallet?.id ? `?walletId=${wallet.id}` : '',
    ],
    enabled: !!wallet?.id,
  });

  const mergedLimits = {
    ...DEFAULT_RISK_LIMITS,
    ...(capitalStatus?.limits || {}),
  } as typeof DEFAULT_RISK_LIMITS;
  const slippagePct = (Number(mergedLimits.maxSlippageBps) || 2000) / 100;
  const riskRows = [
    {
      label: 'Max Slippage',
      value: `${slippagePct.toFixed(1)}%`,
    },
  ];
  const { data: dashboardApiKey, isLoading: apiKeyLoading } = useQuery<string>({
    queryKey: [
      '/api/dashboard/api-key',
    ],
    queryFn: async () => {
      const cached = getStoredApiKey();
      if (cached) return cached;
      return provisionDashboardApiKey();
    },
    staleTime: Infinity,
  });

  const killSwitchMutation = useMutation({
    mutationFn: async (params: { enabled: boolean; mode: string }) => {
      const res = await apiRequest('POST', '/api/killswitch', {
        walletId: wallet?.id,
        ...params,
      });
      return res.json();
    },
    onMutate: async (nextState) => {
      await queryClient.cancelQueries({
        queryKey: killSwitchQueryKey,
      });
      const previous = queryClient.getQueryData<KillSwitch>(killSwitchQueryKey);
      queryClient.setQueryData<KillSwitch>(killSwitchQueryKey, (current) => ({
        ...(current || {
          walletId: wallet?.id || '',
          updatedAt: new Date().toISOString(),
        }),
        enabled: nextState.enabled,
        mode: nextState.mode,
        updatedAt: new Date().toISOString(),
      }));
      return {
        previous,
      };
    },
    onError: (_err, _nextState, context) => {
      if (context?.previous) {
        queryClient.setQueryData(killSwitchQueryKey, context.previous);
      }
      toast({
        title: 'Kill switch update failed',
        variant: 'destructive',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: killSwitchQueryKey,
      });
      toast({
        title: 'Kill switch updated',
      });
    },
  });

  const policyQueryKey = ['/api/wallet/trading-policy', wallet?.id ? `?walletId=${wallet.id}` : ''];
  const { data: tradingPolicy, isLoading: policyLoading } = useQuery<TradingPolicy>({
    queryKey: policyQueryKey,
    enabled: !!wallet?.id,
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/wallet/trading-policy?walletId=${wallet!.id}`);
      return res.json();
    },
  });

  const activePolicyDraft = policyDraft ?? tradingPolicy ?? {
    riskEnforcement: 'off' as EnforcementMode,
    buyFilterEnforcement: 'off' as EnforcementMode,
    buyFilters: {},
    alphaFilters: {},
    onePurchasePerToken: false,
    maxSlippageBps: 2000,
  };

  const savePolicyMutation = useMutation({
    mutationFn: async (policy: TradingPolicy) => {
      const res = await apiRequest('PATCH', '/api/wallet/trading-policy', {
        walletId: wallet?.id,
        ...policy,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.message || `Save failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: policyQueryKey });
      setPolicyDraft(null);
      toast({ title: 'Trading policy saved' });
    },
    onError: (err: Error) => {
      toast({ title: 'Save failed', description: err.message, variant: 'destructive' });
    },
  });

  const riskDefaultsQueryKey = ['/api/wallet/risk-defaults', wallet?.id ?? ''] as const;
  const {
    data: riskDefaultsApi,
    isLoading: riskDefaultsLoading,
    isError: riskDefaultsError,
    refetch: refetchRiskDefaults,
  } = useQuery<RiskDefaultsApiResponse>({
    queryKey: riskDefaultsQueryKey,
    enabled: !!wallet?.id,
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/wallet/risk-defaults?walletId=${encodeURIComponent(wallet!.id)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.message || `HTTP ${res.status}`);
      }
      return res.json() as Promise<RiskDefaultsApiResponse>;
    },
  });

  const [riskDefaultsDraft, setRiskDefaultsDraft] = useState<RiskDefaultsShape | null>(null);

  const effectiveRiskDefaults = useMemo((): RiskDefaultsShape | null => {
    if (riskDefaultsDraft) return riskDefaultsDraft;
    if (riskDefaultsApi?.defaults) return cloneRiskDefaults(riskDefaultsApi.defaults);
    return null;
  }, [riskDefaultsDraft, riskDefaultsApi]);

  const riskDefaultsValidationMessage = useMemo(() => {
    if (!effectiveRiskDefaults) return null;
    return validateWalletRiskDefaults(effectiveRiskDefaults);
  }, [effectiveRiskDefaults]);

  const patchRiskDefaults = (fn: (d: RiskDefaultsShape) => RiskDefaultsShape) => {
    if (!riskDefaultsApi?.defaults && !riskDefaultsDraft) return;
    setRiskDefaultsDraft((prev) => {
      const base = cloneRiskDefaults(prev ?? riskDefaultsApi!.defaults);
      return fn(base);
    });
  };

  const saveRiskDefaultsMutation = useMutation({
    mutationFn: async (payload: RiskDefaultsShape) => {
      const err = validateWalletRiskDefaults(payload);
      if (err) throw new Error(err);
      const res = await apiRequest('PUT', '/api/wallet/risk-defaults', {
        walletId: wallet!.id,
        tpExits: payload.tpExits,
        slExits: payload.slExits,
        trailingStop: payload.trailingStop,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.message || `Save failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: riskDefaultsQueryKey });
      setRiskDefaultsDraft(null);
      toast({ title: 'Exit defaults saved', description: 'Used when enforcement is Off (missing exits), Soft, or Hard.' });
    },
    onError: (err: Error) => {
      toast({ title: 'Could not save exit defaults', description: err.message, variant: 'destructive' });
    },
  });

  const riskDefaultsDirty = useMemo(() => {
    if (!riskDefaultsDraft || !riskDefaultsApi?.defaults) return false;
    return JSON.stringify(riskDefaultsDraft) !== JSON.stringify(cloneRiskDefaults(riskDefaultsApi.defaults));
  }, [riskDefaultsDraft, riskDefaultsApi]);

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <h1 className="text-2xl font-semibold" data-testid="text-page-title">
        Settings
      </h1>

      <Tabs defaultValue="account" className="w-full max-w-4xl xl:max-w-[56rem] 2xl:max-w-[50%]">
        <TabsList className="mb-4 overflow-x-auto">
          <TabsTrigger value="account" data-testid="tab-settings-account" className="gap-1.5">
            <Server className="w-3.5 h-3.5" />
            Account &amp; risk
          </TabsTrigger>
          <TabsTrigger value="agent" data-testid="tab-settings-agent" className="gap-1.5">
            <SlidersHorizontal className="w-3.5 h-3.5" />
            Agent configuration
          </TabsTrigger>
        </TabsList>

        <TabsContent value="account" className="space-y-6 mt-0">
      <Card data-testid="card-killswitch-settings">
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Power className="w-4 h-4 text-foreground" />
            Kill Switch Controls
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {ksLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-sm font-medium">Emergency Kill Switch</div>
                  <div className="text-xs text-muted-foreground">Immediately halts all trading activity</div>
                </div>
                <Switch
                  data-testid="switch-killswitch-settings"
                  checked={killSwitch?.enabled ?? false}
                  disabled={killSwitchMutation.isPending}
                  onCheckedChange={(checked) =>
                    killSwitchMutation.mutate({
                      enabled: checked,
                      mode: killSwitch?.mode ?? 'TRADES_ONLY',
                    })
                  }
                />
              </div>
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground">Kill Switch Mode</div>
                <Select
                  value={killSwitch?.mode ?? 'TRADES_ONLY'}
                  disabled={killSwitchMutation.isPending}
                  onValueChange={(mode) =>
                    killSwitchMutation.mutate({
                      enabled: killSwitch?.enabled ?? false,
                      mode,
                    })
                  }
                >
                  <SelectTrigger data-testid="select-killswitch-mode-settings" className="text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TRADES_ONLY">Trades Only — blocks buy/sell, keeps data streams</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {killSwitchMutation.isPending ? (
                <div className="text-xs text-muted-foreground">Syncing kill switch…</div>
              ) : null}
              <div className="flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:items-center sm:gap-2">
                <span>Last updated:</span>
                <span className="font-mono">
                  {killSwitch?.updatedAt ? new Date(killSwitch.updatedAt).toLocaleString() : '—'}
                </span>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-risk-params">
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-foreground" />
            Active Limits
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {riskRows.map(({ label, value }) => (
              <div key={label} className="flex flex-col gap-1 rounded bg-muted/30 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-xs text-muted-foreground">{label}</span>
                <span className="text-xs font-mono font-medium">{value}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card data-testid="card-wallet-info">
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Server className="w-4 h-4 text-foreground" />
            Wallet Info
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-xs text-muted-foreground">Public Key</span>
            <span className="text-xs font-mono break-all sm:text-right">{wallet?.publicKey ?? '—'}</span>
          </div>
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-xs text-muted-foreground">Label</span>
            <span className="text-xs">{wallet?.label ?? '—'}</span>
          </div>
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-xs text-muted-foreground">Strategy Profile</span>
            <Badge variant="outline" className="text-[10px]">
              {wallet?.strategyProfile ?? '—'}
            </Badge>
          </div>
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-xs text-muted-foreground">Status</span>
            <Badge variant="outline" className="text-[10px]">
              {wallet?.status ?? '—'}
            </Badge>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="card-agent-api-key">
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-foreground" />
            Agent Connection API Key
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Use this API key to connect your external agent runtime to this OpenClaw account.
          </p>
          {apiKeyLoading ? (
            <Skeleton className="h-9 w-full" />
          ) : (
            <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
              <span className="text-xs font-mono break-all">{dashboardApiKey || '—'}</span>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!dashboardApiKey}
              onClick={async () => {
                if (!dashboardApiKey) return;
                await navigator.clipboard.writeText(dashboardApiKey);
                toast({
                  title: 'API key copied',
                  description: 'Share this key with your agent runtime configuration.',
                });
              }}
              data-testid="button-copy-agent-api-key"
            >
              <Copy className="w-3.5 h-3.5 mr-1.5" />
              Copy API Key
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (CLI_INSTALL_LINK_PLACEHOLDER === '#') {
                  toast({
                    title: 'CLI link placeholder',
                    description: 'Replace CLI_INSTALL_LINK_PLACEHOLDER in settings page with your install URL.',
                  });
                  return;
                }
                window.open(CLI_INSTALL_LINK_PLACEHOLDER, '_blank', 'noopener,noreferrer');
              }}
              data-testid="button-cli-install-placeholder"
            >
              <TerminalSquare className="w-3.5 h-3.5 mr-1.5" />
              Install CLI (placeholder)
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="card-session">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Session</CardTitle>
        </CardHeader>
        <CardContent>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              await logoutUserSession();
              window.location.reload();
            }}
            data-testid="button-signout"
          >
            Sign out
          </Button>
        </CardContent>
      </Card>
        </TabsContent>

        <TabsContent value="trading-policy" className="space-y-6 mt-0">
          <div className="text-sm text-muted-foreground space-y-2">
            <p>Trading policy has been moved to dedicated pages.</p>
            <p>Configure <a href="/risk-strategy" className="underline text-primary">Risk Strategy</a> and <a href="/buy-strategy" className="underline text-primary">Buy Strategy</a> from the sidebar.</p>
          </div>
        </TabsContent>
        <TabsContent value="trading-policy-REMOVED-PLACEHOLDER" className="space-y-6 mt-0">
          {!wallet?.id ? (
            <EmptyState
              icon={Wallet}
              title="No wallet found"
              description="Create a wallet first to configure risk and buy strategy defaults."
              className="max-w-xl"
            />
          ) : (
            <>
              {riskDefaultsLoading ? (
                <Skeleton className="h-96 w-full" data-testid="skeleton-risk-defaults" />
              ) : riskDefaultsError ? (
                <Card data-testid="card-risk-defaults-error">
                  <CardContent className="py-6 flex flex-col sm:flex-row sm:items-center gap-2 text-sm text-destructive">
                    <span>Could not load wallet exit defaults.</span>
                    <Button type="button" size="sm" variant="outline" onClick={() => void refetchRiskDefaults()}>
                      Retry
                    </Button>
                  </CardContent>
                </Card>
              ) : effectiveRiskDefaults ? (
                <Card data-testid="card-wallet-risk-defaults">
                  <CardHeader>
                    <CardTitle className="text-sm font-medium flex items-center gap-2 flex-wrap">
                      <Target className="w-4 h-4 text-foreground" />
                      Wallet exit defaults (TP / SL / Trailing)
                      {riskDefaultsApi ? (
                        <Badge variant={riskDefaultsApi.source === 'user' ? 'default' : 'secondary'} className="text-[10px]">
                          {riskDefaultsApi.source === 'user' ? 'Saved on wallet' : 'Using platform defaults (not saved yet)'}
                        </Badge>
                      ) : null}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <p className="text-xs text-muted-foreground">
                      These levels are what the server uses when a buy omits exits (<span className="font-semibold">Off</span>), what soft/hard
                      enforcement compares against (<span className="font-semibold">Soft</span> / <span className="font-semibold">Hard</span>), and what{' '}
                      <span className="font-semibold">Hard</span> forces onto the agent. Deadlock (DL) is still driven by CaptureSell / position wiring — configure per trade on the server if needed.
                    </p>
                    {riskDefaultsApi?.updatedAt ? (
                      <p className="text-xs text-muted-foreground">
                        Last saved:{' '}
                        <span className="font-mono">{new Date(riskDefaultsApi.updatedAt).toLocaleString()}</span>
                      </p>
                    ) : null}

                    {riskDefaultsValidationMessage ? (
                      <p
                        className="text-xs text-destructive border border-destructive/40 rounded-md px-3 py-2"
                        data-testid="text-risk-defaults-validation"
                        role="alert"
                      >
                        {riskDefaultsValidationMessage}
                      </p>
                    ) : null}

                    <div className="space-y-2">
                      <div className="text-xs font-medium">Take profit (gain % → sell % of position)</div>
                      <p className="text-[11px] text-muted-foreground">
                        Each level&apos;s gain % must be <span className="font-semibold">≥</span> the previous (stages further up). Sell % is 1–100 per level.
                      </p>
                      <div className="space-y-2">
                        {effectiveRiskDefaults.tpExits.map((row, i) => (
                          <div key={`tp-${i}`} className="flex flex-wrap items-center gap-2">
                            <Input
                              type="number"
                              className="text-xs h-8 w-24"
                              min={0}
                              step={1}
                              value={row.percent}
                              onChange={(e) => {
                                const raw = parseFloat(e.target.value);
                                if (!Number.isFinite(raw)) return;
                                patchRiskDefaults((d) => {
                                  const next = [...d.tpExits];
                                  next[i] = { ...next[i], percent: Math.max(0.0001, raw) };
                                  d.tpExits = next;
                                  return d;
                                });
                              }}
                            />
                            <span className="text-xs text-muted-foreground">% gain →</span>
                            <Input
                              type="number"
                              className="text-xs h-8 w-20"
                              min={1}
                              max={100}
                              value={row.amountPct}
                              onChange={(e) => {
                                const raw = parseFloat(e.target.value);
                                if (!Number.isFinite(raw)) return;
                                patchRiskDefaults((d) => {
                                  const next = [...d.tpExits];
                                  next[i] = { ...next[i], amountPct: clampAmountPct(raw) };
                                  d.tpExits = next;
                                  return d;
                                });
                              }}
                            />
                            <span className="text-xs text-muted-foreground">% sell</span>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 shrink-0"
                              disabled={effectiveRiskDefaults.tpExits.length <= 1}
                              onClick={() =>
                                patchRiskDefaults((d) => {
                                  d.tpExits = d.tpExits.filter((_, j) => j !== i);
                                  if (d.tpExits.length === 0) d.tpExits = [{ percent: 100, amountPct: 50 }];
                                  return d;
                                })
                              }
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        ))}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() =>
                            patchRiskDefaults((d) => {
                              const last = d.tpExits[d.tpExits.length - 1]?.percent ?? 100;
                              d.tpExits = [...d.tpExits, { percent: last + 10, amountPct: 25 }];
                              return d;
                            })
                          }
                        >
                          <Plus className="w-3 h-3 mr-1" />
                          Add TP level
                        </Button>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="text-xs font-medium">Stop loss (drawdown % → sell % of position)</div>
                      <p className="text-[11px] text-muted-foreground">
                        Drawdown is capped at <span className="font-semibold">100%</span>. Each level&apos;s drawdown must be <span className="font-semibold">≥</span> the previous. Sell % is 1–100 per level.
                      </p>
                      <div className="space-y-2">
                        {effectiveRiskDefaults.slExits.map((row, i) => (
                          <div key={`sl-${i}`} className="flex flex-wrap items-center gap-2">
                            <Input
                              type="number"
                              className="text-xs h-8 w-24"
                              min={0}
                              max={100}
                              step={1}
                              value={row.percent}
                              onChange={(e) => {
                                const raw = parseFloat(e.target.value);
                                if (!Number.isFinite(raw)) return;
                                patchRiskDefaults((d) => {
                                  const next = [...d.slExits];
                                  next[i] = { ...next[i], percent: clampSlDrawdownPct(raw) };
                                  d.slExits = next;
                                  return d;
                                });
                              }}
                            />
                            <span className="text-xs text-muted-foreground">% drawdown →</span>
                            <Input
                              type="number"
                              className="text-xs h-8 w-20"
                              min={1}
                              max={100}
                              value={row.amountPct}
                              onChange={(e) => {
                                const raw = parseFloat(e.target.value);
                                if (!Number.isFinite(raw)) return;
                                patchRiskDefaults((d) => {
                                  const next = [...d.slExits];
                                  next[i] = { ...next[i], amountPct: clampAmountPct(raw) };
                                  d.slExits = next;
                                  return d;
                                });
                              }}
                            />
                            <span className="text-xs text-muted-foreground">% sell</span>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 shrink-0"
                              disabled={effectiveRiskDefaults.slExits.length <= 1}
                              onClick={() =>
                                patchRiskDefaults((d) => {
                                  d.slExits = d.slExits.filter((_, j) => j !== i);
                                  if (d.slExits.length === 0) d.slExits = [{ percent: 45, amountPct: 100 }];
                                  return d;
                                })
                              }
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        ))}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() =>
                            patchRiskDefaults((d) => {
                              const last = d.slExits[d.slExits.length - 1]?.percent ?? 45;
                              const nextPct = Math.min(100, last + 5);
                              d.slExits = [...d.slExits, { percent: nextPct >= last ? nextPct : last, amountPct: 100 }];
                              return d;
                            })
                          }
                        >
                          <Plus className="w-3 h-3 mr-1" />
                          Add SL level
                        </Button>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="text-xs font-medium">Trailing stop (levels)</div>
                      <p className="text-[11px] text-muted-foreground">
                        Each level: trail % from peak, % of position to close (1–100), optional ATH gate. Unlike TP/SL, levels do <span className="font-semibold">not</span> need to be ordered by trigger.
                      </p>
                      <div className="space-y-2">
                        {effectiveRiskDefaults.trailingStop.levels.map((row, i) => (
                          <div
                            key={`ts-${i}`}
                            className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border/60 p-2"
                          >
                            <span className="text-[10px] text-muted-foreground w-full sm:w-auto">Level {i + 1}</span>
                            <Input
                              type="number"
                              className="text-xs h-8 w-20"
                              placeholder="trail %"
                              value={row.percentage}
                              onChange={(e) => {
                                const raw = parseFloat(e.target.value);
                                if (!Number.isFinite(raw)) return;
                                patchRiskDefaults((d) => {
                                  const next = [...d.trailingStop.levels];
                                  next[i] = { ...next[i], percentage: Math.max(0.0001, raw) };
                                  d.trailingStop = { levels: next };
                                  return d;
                                });
                              }}
                            />
                            <Input
                              type="number"
                              className="text-xs h-8 w-20"
                              placeholder="amt %"
                              min={1}
                              max={100}
                              value={row.amount}
                              onChange={(e) => {
                                const raw = parseFloat(e.target.value);
                                if (!Number.isFinite(raw)) return;
                                patchRiskDefaults((d) => {
                                  const next = [...d.trailingStop.levels];
                                  next[i] = { ...next[i], amount: clampAmountPct(raw) };
                                  d.trailingStop = { levels: next };
                                  return d;
                                });
                              }}
                            />
                            <Input
                              type="number"
                              className="text-xs h-8 w-24"
                              placeholder="ATH gate"
                              value={row.triggerAboveATH ?? 100}
                              onChange={(e) => {
                                const raw = parseFloat(e.target.value);
                                if (!Number.isFinite(raw)) return;
                                patchRiskDefaults((d) => {
                                  const next = [...d.trailingStop.levels];
                                  next[i] = { ...next[i], triggerAboveATH: Math.max(0.0001, raw) };
                                  d.trailingStop = { levels: next };
                                  return d;
                                });
                              }}
                            />
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 shrink-0"
                              disabled={effectiveRiskDefaults.trailingStop.levels.length <= 1}
                              onClick={() =>
                                patchRiskDefaults((d) => {
                                  const next = d.trailingStop.levels.filter((_, j) => j !== i);
                                  d.trailingStop = {
                                    levels: next.length ? next : [{ percentage: 25, amount: 100, triggerAboveATH: 100 }],
                                  };
                                  return d;
                                })
                              }
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        ))}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          disabled={effectiveRiskDefaults.trailingStop.levels.length >= 5}
                          onClick={() =>
                            patchRiskDefaults((d) => {
                              d.trailingStop = {
                                levels: [
                                  ...d.trailingStop.levels,
                                  { percentage: 20, amount: 50, triggerAboveATH: 100 },
                                ],
                              };
                              return d;
                            })
                          }
                        >
                          <Plus className="w-3 h-3 mr-1" />
                          Add trailing level
                        </Button>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2 pt-2">
                      <Button
                        type="button"
                        size="sm"
                        disabled={
                          !riskDefaultsDirty ||
                          saveRiskDefaultsMutation.isPending ||
                          Boolean(riskDefaultsValidationMessage)
                        }
                        onClick={() => {
                          if (!effectiveRiskDefaults) return;
                          const msg = validateWalletRiskDefaults(effectiveRiskDefaults);
                          if (msg) {
                            toast({ title: 'Fix exit defaults', description: msg, variant: 'destructive' });
                            return;
                          }
                          saveRiskDefaultsMutation.mutate(effectiveRiskDefaults);
                        }}
                        data-testid="button-save-risk-defaults"
                      >
                        {saveRiskDefaultsMutation.isPending ? 'Saving…' : 'Save exit defaults'}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!riskDefaultsDraft || saveRiskDefaultsMutation.isPending}
                        onClick={() => setRiskDefaultsDraft(null)}
                      >
                        Discard edits
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={saveRiskDefaultsMutation.isPending}
                        onClick={() =>
                          setRiskDefaultsDraft(cloneRiskDefaults(SYSTEM_WALLET_RISK_DEFAULTS_UI as unknown as RiskDefaultsShape))
                        }
                      >
                        Reset form to platform defaults
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ) : null}

              {policyLoading ? (
                <Skeleton className="h-64 w-full" />
              ) : (
                <>
              <Card data-testid="card-risk-enforcement">
                <CardHeader>
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <ShieldCheckered className="w-4 h-4 text-foreground" />
                    Risk exit enforcement (TP / SL / Trailing)
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="text-xs text-muted-foreground">
                    Controls how strictly the wallet exit defaults above are applied to agent trades.
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium mb-0.5">Enforcement mode</div>
                      <div className="text-xs text-muted-foreground">
                        <span className="font-semibold">Off</span> — defaults only when agent sends none.{" "}
                        <span className="font-semibold">Soft</span> — warn when agent differs.{" "}
                        <span className="font-semibold">Hard</span> — always override agent exits.
                      </div>
                      {tradingPolicy && (
                        <div className="text-xs text-muted-foreground mt-1">
                          Saved:{" "}
                          <span className={`font-semibold ${ENFORCEMENT_LABELS[tradingPolicy.riskEnforcement]?.color}`}>
                            {ENFORCEMENT_LABELS[tradingPolicy.riskEnforcement]?.short ?? tradingPolicy.riskEnforcement}
                          </span>
                        </div>
                      )}
                    </div>
                    <EnforcementSelect
                      value={activePolicyDraft.riskEnforcement}
                      onChange={(v) => setPolicyDraft({ ...activePolicyDraft, riskEnforcement: v })}
                      disabled={savePolicyMutation.isPending}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card data-testid="card-buy-filter-enforcement">
                <CardHeader>
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <SlidersHorizontal className="w-4 h-4 text-foreground" />
                    Buy filter enforcement
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="text-xs text-muted-foreground">
                    Token metrics checked before allowing a buy. Leave bounds empty to skip that check.
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium mb-0.5">Enforcement mode</div>
                      <div className="text-xs text-muted-foreground">
                        <span className="font-semibold">Hard</span> — deny buy when outside bounds.{" "}
                        <span className="font-semibold">Soft</span> — approve with warnings.
                      </div>
                      {tradingPolicy && (
                        <div className="text-xs text-muted-foreground mt-1">
                          Saved:{" "}
                          <span className={`font-semibold ${ENFORCEMENT_LABELS[tradingPolicy.buyFilterEnforcement]?.color}`}>
                            {ENFORCEMENT_LABELS[tradingPolicy.buyFilterEnforcement]?.short ?? tradingPolicy.buyFilterEnforcement}
                          </span>
                        </div>
                      )}
                    </div>
                    <EnforcementSelect
                      value={activePolicyDraft.buyFilterEnforcement}
                      onChange={(v) => setPolicyDraft({ ...activePolicyDraft, buyFilterEnforcement: v })}
                      disabled={savePolicyMutation.isPending}
                    />
                  </div>
                  <FilterBoundsForm
                    label="Buy filter bounds"
                    bounds={activePolicyDraft.buyFilters}
                    disabled={savePolicyMutation.isPending || activePolicyDraft.buyFilterEnforcement === 'off'}
                    onChange={(b) => setPolicyDraft({ ...activePolicyDraft, buyFilters: b })}
                  />
                </CardContent>
              </Card>

              {/* Alpha signal filters have moved to the Alpha page */}

              <Card data-testid="card-one-purchase">
                <CardHeader>
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-foreground" />
                    One purchase per token
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium">Limit agent to one buy per token</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        When on, the agent cannot open a second position on a token that already has an open trade.
                      </div>
                    </div>
                    <Switch
                      checked={activePolicyDraft.onePurchasePerToken}
                      disabled={savePolicyMutation.isPending}
                      onCheckedChange={(v) => setPolicyDraft({ ...activePolicyDraft, onePurchasePerToken: v })}
                      data-testid="switch-one-purchase-per-token"
                    />
                  </div>
                </CardContent>
              </Card>

              <div className="flex gap-2">
                <Button
                  disabled={savePolicyMutation.isPending || !policyDraft}
                  onClick={() => savePolicyMutation.mutate(activePolicyDraft)}
                  data-testid="button-save-trading-policy"
                >
                  {savePolicyMutation.isPending ? 'Saving…' : 'Save policy'}
                </Button>
                {policyDraft && (
                  <Button
                    variant="outline"
                    disabled={savePolicyMutation.isPending}
                    onClick={() => setPolicyDraft(null)}
                  >
                    Discard changes
                  </Button>
                )}
              </div>
                </>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="agent" className="mt-0">
          <AgentSettingsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
