import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertTriangle, SlidersHorizontal, Wallet } from "@/components/ui/icons";
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/hooks/use-toast';
import type { Wallet as WalletType } from '@shared/schema';

// ─── Types ────────────────────────────────────────────────────────────────────

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
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ENFORCEMENT_LABELS: Record<EnforcementMode, { short: string; description: string; color: string }> = {
  off:  { short: 'Off',  description: 'Off — no enforcement',    color: 'text-muted-foreground' },
  soft: { short: 'Soft', description: 'Soft — warn only',        color: 'text-yellow-400' },
  hard: { short: 'Hard', description: 'Hard — block / override', color: 'text-loss' },
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

const FILTER_FIELDS: Array<{ key: keyof BuyFilterBounds; label: string; prefix?: string; suffix?: string }> = [
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

function FilterBoundsForm({ bounds, onChange, disabled }: { bounds: BuyFilterBounds; onChange: (b: BuyFilterBounds) => void; disabled?: boolean }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {FILTER_FIELDS.map(({ key, label, prefix, suffix }) => (
        <div key={key} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
          <span className="w-full shrink-0 text-xs text-muted-foreground sm:w-36">{label}</span>
          <div className="relative w-full flex-1">
            {prefix && (
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{prefix}</span>
            )}
            <Input
              type="number" min={0} disabled={disabled}
              value={bounds[key] ?? ''}
              placeholder="—"
              className={`text-xs h-7 ${prefix ? 'pl-5' : ''} ${suffix ? 'pr-7' : ''}`}
              onChange={(e) => {
                const raw = e.target.value;
                onChange({ ...bounds, [key]: raw === '' ? undefined : Number(raw) });
              }}
            />
            {suffix && (
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{suffix}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BuyStrategy() {
  const { toast } = useToast();

  const { data: wallets } = useQuery<WalletType[]>({ queryKey: ['/api/wallets'] });
  const wallet = wallets?.[0];

  const policyQueryKey = ['/api/wallet/trading-policy', wallet?.id ? `?walletId=${wallet.id}` : ''];
  const { data: tradingPolicy, isLoading: policyLoading } = useQuery<TradingPolicy>({
    queryKey: policyQueryKey,
    enabled: !!wallet?.id,
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/wallet/trading-policy?walletId=${wallet!.id}`);
      return res.json();
    },
  });

  const [policyDraft, setPolicyDraft] = useState<Partial<TradingPolicy> | null>(null);

  const activeDraft: TradingPolicy = {
    riskEnforcement: 'off',
    buyFilterEnforcement: 'off',
    buyFilters: {},
    alphaFilters: {},
    onePurchasePerToken: false,
    ...tradingPolicy,
    ...policyDraft,
  };

  const savePolicyMutation = useMutation({
    mutationFn: async (policy: Partial<TradingPolicy>) => {
      const res = await apiRequest('PATCH', '/api/wallet/trading-policy', {
        walletId: wallet?.id,
        ...policy,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { message?: string })?.message || `Save failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: policyQueryKey });
      setPolicyDraft(null);
      toast({ title: 'Buy strategy saved' });
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
          description="Create a wallet first to configure buy strategy rules."
          className="max-w-xl"
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold">Buy Strategy</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Configure which tokens the agent is allowed to buy and how strictly those bounds are enforced.
        </p>
      </div>

      {policyLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          {/* Buy filter enforcement + bounds */}
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
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium mb-0.5">Enforcement mode</div>
                  <div className="text-xs text-muted-foreground">
                    <span className="font-semibold">Hard</span> — deny buy when outside bounds.{' '}
                    <span className="font-semibold">Soft</span> — approve with warnings.{' '}
                    <span className="font-semibold">Off</span> — no filter applied.
                  </div>
                  {tradingPolicy && (
                    <div className="text-xs text-muted-foreground mt-1">
                      Saved:{' '}
                      <span className={`font-semibold ${ENFORCEMENT_LABELS[tradingPolicy.buyFilterEnforcement]?.color}`}>
                        {ENFORCEMENT_LABELS[tradingPolicy.buyFilterEnforcement]?.short ?? tradingPolicy.buyFilterEnforcement}
                      </span>
                    </div>
                  )}
                </div>
                <EnforcementSelect
                  value={activeDraft.buyFilterEnforcement}
                  onChange={(v) => setPolicyDraft({ ...policyDraft, buyFilterEnforcement: v })}
                  disabled={savePolicyMutation.isPending}
                />
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">Buy filter bounds</div>
                <FilterBoundsForm
                  bounds={activeDraft.buyFilters}
                  disabled={savePolicyMutation.isPending || activeDraft.buyFilterEnforcement === 'off'}
                  onChange={(b) => setPolicyDraft({ ...policyDraft, buyFilters: b })}
                />
              </div>
            </CardContent>
          </Card>

          {/* One purchase per token */}
          <Card data-testid="card-one-purchase">
            <CardHeader>
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-foreground" />
                One purchase per token
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-sm font-medium">Limit agent to one buy per token</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    When on, the agent cannot open a second position on a token that already has an open trade.
                  </div>
                </div>
                <Switch
                  checked={activeDraft.onePurchasePerToken}
                  disabled={savePolicyMutation.isPending}
                  onCheckedChange={(v) => setPolicyDraft({ ...policyDraft, onePurchasePerToken: v })}
                  data-testid="switch-one-purchase-per-token"
                />
              </div>
            </CardContent>
          </Card>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              disabled={savePolicyMutation.isPending || policyDraft === null}
              onClick={() => savePolicyMutation.mutate(activeDraft)}
              data-testid="button-save-buy-strategy"
            >
              {savePolicyMutation.isPending ? 'Saving…' : 'Save buy strategy'}
            </Button>
            {policyDraft !== null && (
              <Button variant="outline" disabled={savePolicyMutation.isPending} onClick={() => setPolicyDraft(null)}>
                Discard changes
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
