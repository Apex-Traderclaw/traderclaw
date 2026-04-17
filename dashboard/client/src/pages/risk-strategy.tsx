import { useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ShieldCheckered, Target, Plus, Trash2, Wallet } from "@/components/ui/icons";
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/hooks/use-toast';
import type { Wallet as WalletType } from '@shared/schema';

// ─── Types ────────────────────────────────────────────────────────────────────

type EnforcementMode = 'off' | 'soft' | 'hard';

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

type TradingPolicy = {
  riskEnforcement: EnforcementMode;
  buyFilterEnforcement: EnforcementMode;
  buyFilters: Record<string, number | undefined>;
  alphaFilters: Record<string, number | undefined>;
  onePurchasePerToken: boolean;
  maxSlippageBps: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SYSTEM_RISK_DEFAULTS_UI: RiskDefaultsShape = {
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
};

function cloneRiskDefaults(d: RiskDefaultsShape): RiskDefaultsShape {
  return JSON.parse(JSON.stringify(d)) as RiskDefaultsShape;
}

function clampAmountPct(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(100, Math.max(1, n));
}

function clampSlDrawdownPct(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(100, Math.max(0.0001, n));
}

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
        {(Object.entries(ENFORCEMENT_LABELS) as [EnforcementMode, (typeof ENFORCEMENT_LABELS)[EnforcementMode]][]).map(([k, m]) => (
          <SelectItem key={k} value={k}>
            <span className={`font-semibold ${m.color} mr-1`}>{m.short}</span>
            <span className="text-muted-foreground">{m.description.split('—')[1]?.trim()}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RiskStrategy() {
  const { toast } = useToast();

  const { data: wallets } = useQuery<WalletType[]>({ queryKey: ['/api/wallets'] });
  const wallet = wallets?.[0];

  // Risk defaults (TP/SL/trailing)
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
        throw new Error((body as { message?: string })?.message || `HTTP ${res.status}`);
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
        throw new Error((body as { message?: string })?.message || `Save failed (${res.status})`);
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

  // Risk enforcement (part of trading policy)
  const policyQueryKey = ['/api/wallet/trading-policy', wallet?.id ? `?walletId=${wallet.id}` : ''];
  const { data: tradingPolicy, isLoading: policyLoading } = useQuery<TradingPolicy>({
    queryKey: policyQueryKey,
    enabled: !!wallet?.id,
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/wallet/trading-policy?walletId=${wallet!.id}`);
      return res.json();
    },
  });

  const [enforcementDraft, setEnforcementDraft] = useState<EnforcementMode | null>(null);
  const activeEnforcement: EnforcementMode = enforcementDraft ?? tradingPolicy?.riskEnforcement ?? 'off';

  const saveEnforcementMutation = useMutation({
    mutationFn: async (riskEnforcement: EnforcementMode) => {
      const res = await apiRequest('PATCH', '/api/wallet/trading-policy', {
        walletId: wallet?.id,
        riskEnforcement,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { message?: string })?.message || `Save failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: policyQueryKey });
      setEnforcementDraft(null);
      toast({ title: 'Risk enforcement saved' });
    },
    onError: (err: Error) => {
      toast({ title: 'Save failed', description: err.message, variant: 'destructive' });
    },
  });

  // Slippage — stored as bps, displayed as percentage (bps / 100)
  const [slippagePctDraft, setSlippagePctDraft] = useState<string | null>(null);
  const savedSlippagePct = tradingPolicy ? (tradingPolicy.maxSlippageBps ?? 2000) / 100 : 20;
  const displaySlippagePct = slippagePctDraft !== null ? slippagePctDraft : String(savedSlippagePct);

  const saveSlippageMutation = useMutation({
    mutationFn: async (pct: number) => {
      const bps = Math.round(pct * 100);
      if (!Number.isFinite(bps) || bps < 1 || bps > 10000) throw new Error('Slippage must be between 0.01% and 100%');
      const res = await apiRequest('PATCH', '/api/wallet/trading-policy', {
        walletId: wallet?.id,
        maxSlippageBps: bps,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { message?: string })?.message || `Save failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: policyQueryKey });
      setSlippagePctDraft(null);
      toast({ title: 'Slippage limit saved' });
    },
    onError: (err: Error) => {
      toast({ title: 'Save failed', description: err.message, variant: 'destructive' });
    },
  });

  if (!wallet?.id) {
    return (
      <div className="px-4 py-4 sm:px-6 sm:py-6">
        <EmptyState
          icon={Wallet}
          title="No wallet found"
          description="Create a wallet first to configure risk strategy defaults."
          className="max-w-xl"
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold">Risk Strategy</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Configure default exit levels (TP / SL / Trailing) and how strictly they are enforced on agent trades.
        </p>
      </div>

      {/* Enforcement card — shown first so user sets the mode before configuring the levels */}
      {policyLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <Card data-testid="card-risk-enforcement">
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <ShieldCheckered className="w-4 h-4 text-foreground" />
              Risk exit enforcement (TP / SL / Trailing)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-xs text-muted-foreground">
              Controls how strictly the wallet exit defaults below are applied to agent trades.
            </div>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium mb-0.5">Enforcement mode</div>
                <div className="text-xs text-muted-foreground">
                  <span className="font-semibold">Off</span> — defaults only when agent sends none.{' '}
                  <span className="font-semibold">Soft</span> — warn when agent differs.{' '}
                  <span className="font-semibold">Hard</span> — always override agent exits.
                </div>
                {tradingPolicy && (
                  <div className="text-xs text-muted-foreground mt-1">
                    Saved:{' '}
                    <span className={`font-semibold ${ENFORCEMENT_LABELS[tradingPolicy.riskEnforcement]?.color}`}>
                      {ENFORCEMENT_LABELS[tradingPolicy.riskEnforcement]?.short ?? tradingPolicy.riskEnforcement}
                    </span>
                  </div>
                )}
              </div>
              <EnforcementSelect
                value={activeEnforcement}
                onChange={setEnforcementDraft}
                disabled={saveEnforcementMutation.isPending}
              />
            </div>
            <div className="flex flex-col gap-2 pt-1 sm:flex-row">
              <Button size="sm"
                disabled={saveEnforcementMutation.isPending || enforcementDraft === null}
                onClick={() => enforcementDraft && saveEnforcementMutation.mutate(enforcementDraft)}
                data-testid="button-save-risk-enforcement"
              >
                {saveEnforcementMutation.isPending ? 'Saving…' : 'Save enforcement'}
              </Button>
              {enforcementDraft !== null && (
                <Button size="sm" variant="outline"
                  disabled={saveEnforcementMutation.isPending}
                  onClick={() => setEnforcementDraft(null)}
                >Discard</Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Slippage limit card */}
      {policyLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <Card data-testid="card-slippage-limit">
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <ShieldCheckered className="w-4 h-4 text-foreground" />
              Max slippage
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Trades requesting slippage above this threshold will be denied.{' '}
              <span className="font-semibold">20%</span> (2000 bps) is the default. Set to a lower value to protect against extreme price impact.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative w-36">
                <Input
                  type="number"
                  className="text-xs h-8 pr-7"
                  min={0.01}
                  max={100}
                  step={0.1}
                  value={displaySlippagePct}
                  onChange={(e) => setSlippagePctDraft(e.target.value)}
                  data-testid="input-max-slippage-pct"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
              </div>
              {tradingPolicy && (
                <span className="text-xs text-muted-foreground">
                  Saved: <span className="font-mono">{savedSlippagePct.toFixed(1)}%</span>
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={saveSlippageMutation.isPending || slippagePctDraft === null}
                onClick={() => {
                  const pct = parseFloat(displaySlippagePct);
                  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
                    toast({ title: 'Invalid slippage', description: 'Enter a value between 0.01 and 100', variant: 'destructive' });
                    return;
                  }
                  saveSlippageMutation.mutate(pct);
                }}
                data-testid="button-save-slippage"
              >
                {saveSlippageMutation.isPending ? 'Saving…' : 'Save slippage'}
              </Button>
              {slippagePctDraft !== null && (
                <Button size="sm" variant="outline" disabled={saveSlippageMutation.isPending} onClick={() => setSlippagePctDraft(null)}>
                  Discard
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Exit defaults card */}
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
                <span className={`text-[10px] px-1.5 py-0.5 rounded border ${riskDefaultsApi.source === 'user' ? 'border-primary/40 text-primary' : 'border-muted text-muted-foreground'}`}>
                  {riskDefaultsApi.source === 'user' ? 'Saved on wallet' : 'Using platform defaults (not saved yet)'}
                </span>
              ) : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <p className="text-xs text-muted-foreground">
              These levels are what the server uses when a buy omits exits (<span className="font-semibold">Off</span>), what soft/hard
              enforcement compares against (<span className="font-semibold">Soft</span> / <span className="font-semibold">Hard</span>), and what{' '}
              <span className="font-semibold">Hard</span> forces onto the agent. Deadlock (DL) is still driven by CaptureSell / position wiring.
            </p>
            {riskDefaultsApi?.updatedAt ? (
              <p className="text-xs text-muted-foreground">
                Last saved: <span className="font-mono">{new Date(riskDefaultsApi.updatedAt).toLocaleString()}</span>
              </p>
            ) : null}

            {riskDefaultsValidationMessage ? (
              <p className="text-xs text-destructive border border-destructive/40 rounded-md px-3 py-2" role="alert">
                {riskDefaultsValidationMessage}
              </p>
            ) : null}

            {/* Take Profit */}
            <div className="space-y-2">
              <div className="text-xs font-medium">Take profit (gain % → sell % of position)</div>
              <p className="text-[11px] text-muted-foreground">
                Each level&apos;s gain % must be <span className="font-semibold">≥</span> the previous. Sell % is 1–100 per level.
              </p>
              <div className="space-y-2">
                {effectiveRiskDefaults.tpExits.map((row, i) => (
                  <div key={`tp-${i}`} className="flex flex-wrap items-center gap-2">
                    <Input
                      type="number" className="text-xs h-8 w-24" min={0} step={1} value={row.percent}
                      onChange={(e) => {
                        const raw = parseFloat(e.target.value);
                        if (!Number.isFinite(raw)) return;
                        patchRiskDefaults((d) => { const next = [...d.tpExits]; next[i] = { ...next[i], percent: Math.max(0.0001, raw) }; d.tpExits = next; return d; });
                      }}
                    />
                    <span className="text-xs text-muted-foreground">% gain →</span>
                    <Input
                      type="number" className="text-xs h-8 w-20" min={1} max={100} value={row.amountPct}
                      onChange={(e) => {
                        const raw = parseFloat(e.target.value);
                        if (!Number.isFinite(raw)) return;
                        patchRiskDefaults((d) => { const next = [...d.tpExits]; next[i] = { ...next[i], amountPct: clampAmountPct(raw) }; d.tpExits = next; return d; });
                      }}
                    />
                    <span className="text-xs text-muted-foreground">% sell</span>
                    <Button type="button" size="icon" variant="ghost" className="h-8 w-8 shrink-0"
                      disabled={effectiveRiskDefaults.tpExits.length <= 1}
                      onClick={() => patchRiskDefaults((d) => { d.tpExits = d.tpExits.filter((_, j) => j !== i); if (d.tpExits.length === 0) d.tpExits = [{ percent: 100, amountPct: 50 }]; return d; })}
                    ><Trash2 className="w-3.5 h-3.5" /></Button>
                  </div>
                ))}
                <Button type="button" size="sm" variant="outline" className="h-7 text-xs"
                  onClick={() => patchRiskDefaults((d) => { const last = d.tpExits[d.tpExits.length - 1]?.percent ?? 100; d.tpExits = [...d.tpExits, { percent: last + 10, amountPct: 25 }]; return d; })}
                ><Plus className="w-3 h-3 mr-1" />Add TP level</Button>
              </div>
            </div>

            {/* Stop Loss */}
            <div className="space-y-2">
              <div className="text-xs font-medium">Stop loss (drawdown % → sell % of position)</div>
              <p className="text-[11px] text-muted-foreground">
                Drawdown is capped at <span className="font-semibold">100%</span>. Each level&apos;s drawdown must be <span className="font-semibold">≥</span> the previous. Sell % is 1–100 per level.
              </p>
              <div className="space-y-2">
                {effectiveRiskDefaults.slExits.map((row, i) => (
                  <div key={`sl-${i}`} className="flex flex-wrap items-center gap-2">
                    <Input
                      type="number" className="text-xs h-8 w-24" min={0} max={100} step={1} value={row.percent}
                      onChange={(e) => {
                        const raw = parseFloat(e.target.value);
                        if (!Number.isFinite(raw)) return;
                        patchRiskDefaults((d) => { const next = [...d.slExits]; next[i] = { ...next[i], percent: clampSlDrawdownPct(raw) }; d.slExits = next; return d; });
                      }}
                    />
                    <span className="text-xs text-muted-foreground">% drawdown →</span>
                    <Input
                      type="number" className="text-xs h-8 w-20" min={1} max={100} value={row.amountPct}
                      onChange={(e) => {
                        const raw = parseFloat(e.target.value);
                        if (!Number.isFinite(raw)) return;
                        patchRiskDefaults((d) => { const next = [...d.slExits]; next[i] = { ...next[i], amountPct: clampAmountPct(raw) }; d.slExits = next; return d; });
                      }}
                    />
                    <span className="text-xs text-muted-foreground">% sell</span>
                    <Button type="button" size="icon" variant="ghost" className="h-8 w-8 shrink-0"
                      disabled={effectiveRiskDefaults.slExits.length <= 1}
                      onClick={() => patchRiskDefaults((d) => { d.slExits = d.slExits.filter((_, j) => j !== i); if (d.slExits.length === 0) d.slExits = [{ percent: 45, amountPct: 100 }]; return d; })}
                    ><Trash2 className="w-3.5 h-3.5" /></Button>
                  </div>
                ))}
                <Button type="button" size="sm" variant="outline" className="h-7 text-xs"
                  onClick={() => patchRiskDefaults((d) => { const last = d.slExits[d.slExits.length - 1]?.percent ?? 45; const nextPct = Math.min(100, last + 5); d.slExits = [...d.slExits, { percent: nextPct >= last ? nextPct : last, amountPct: 100 }]; return d; })}
                ><Plus className="w-3 h-3 mr-1" />Add SL level</Button>
              </div>
            </div>

            {/* Trailing Stop */}
            <div className="space-y-2">
              <div className="text-xs font-medium">Trailing stop (levels)</div>
              <p className="text-[11px] text-muted-foreground">
                Each level: trail % from peak, % of position to close (1–100), optional ATH gate. Unlike TP/SL, levels do <span className="font-semibold">not</span> need to be ordered by trigger.
              </p>
              <div className="space-y-2">
                {effectiveRiskDefaults.trailingStop.levels.map((row, i) => (
                  <div key={`ts-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border/60 p-2">
                    <span className="text-[10px] text-muted-foreground w-full sm:w-auto">Level {i + 1}</span>
                    <Input type="number" className="text-xs h-8 w-20" placeholder="trail %" value={row.percentage}
                      onChange={(e) => { const raw = parseFloat(e.target.value); if (!Number.isFinite(raw)) return; patchRiskDefaults((d) => { const next = [...d.trailingStop.levels]; next[i] = { ...next[i], percentage: Math.max(0.0001, raw) }; d.trailingStop = { levels: next }; return d; }); }}
                    />
                    <Input type="number" className="text-xs h-8 w-20" placeholder="amt %" min={1} max={100} value={row.amount}
                      onChange={(e) => { const raw = parseFloat(e.target.value); if (!Number.isFinite(raw)) return; patchRiskDefaults((d) => { const next = [...d.trailingStop.levels]; next[i] = { ...next[i], amount: clampAmountPct(raw) }; d.trailingStop = { levels: next }; return d; }); }}
                    />
                    <Input type="number" className="text-xs h-8 w-24" placeholder="ATH gate" value={row.triggerAboveATH ?? 100}
                      onChange={(e) => { const raw = parseFloat(e.target.value); if (!Number.isFinite(raw)) return; patchRiskDefaults((d) => { const next = [...d.trailingStop.levels]; next[i] = { ...next[i], triggerAboveATH: Math.max(0.0001, raw) }; d.trailingStop = { levels: next }; return d; }); }}
                    />
                    <Button type="button" size="icon" variant="ghost" className="h-8 w-8 shrink-0"
                      disabled={effectiveRiskDefaults.trailingStop.levels.length <= 1}
                      onClick={() => patchRiskDefaults((d) => { const next = d.trailingStop.levels.filter((_, j) => j !== i); d.trailingStop = { levels: next.length ? next : [{ percentage: 25, amount: 100, triggerAboveATH: 100 }] }; return d; })}
                    ><Trash2 className="w-3.5 h-3.5" /></Button>
                  </div>
                ))}
                <Button type="button" size="sm" variant="outline" className="h-7 text-xs"
                  disabled={effectiveRiskDefaults.trailingStop.levels.length >= 5}
                  onClick={() => patchRiskDefaults((d) => { d.trailingStop = { levels: [...d.trailingStop.levels, { percentage: 20, amount: 50, triggerAboveATH: 100 }] }; return d; })}
                ><Plus className="w-3 h-3 mr-1" />Add trailing level</Button>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 pt-2">
              <Button type="button" size="sm"
                disabled={!riskDefaultsDirty || saveRiskDefaultsMutation.isPending || Boolean(riskDefaultsValidationMessage)}
                onClick={() => {
                  if (!effectiveRiskDefaults) return;
                  const msg = validateWalletRiskDefaults(effectiveRiskDefaults);
                  if (msg) { toast({ title: 'Fix exit defaults', description: msg, variant: 'destructive' }); return; }
                  saveRiskDefaultsMutation.mutate(effectiveRiskDefaults);
                }}
                data-testid="button-save-risk-defaults"
              >
                {saveRiskDefaultsMutation.isPending ? 'Saving…' : 'Save exit defaults'}
              </Button>
              <Button type="button" size="sm" variant="outline"
                disabled={!riskDefaultsDraft || saveRiskDefaultsMutation.isPending}
                onClick={() => setRiskDefaultsDraft(null)}
              >Discard edits</Button>
              <Button type="button" size="sm" variant="secondary"
                disabled={saveRiskDefaultsMutation.isPending}
                onClick={() => setRiskDefaultsDraft(cloneRiskDefaults(SYSTEM_RISK_DEFAULTS_UI))}
              >Reset to platform defaults</Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

    </div>
  );
}
