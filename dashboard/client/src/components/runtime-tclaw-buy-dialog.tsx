import type { EntitlementPlan } from '@shared/schema';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { cn } from '@/lib/utils';
import { TOKEN_TICKER_DOLLAR } from '@/lib/token-config';

/** Extra SOL reserved for tx fees / rent on top of swap spend (conservative UI guard). */
const SOL_SWAP_FEE_HEADROOM = 0.015;

export type RuntimeTclawBuyPrefill = {
  plan: EntitlementPlan;
  mint: string;
  discountedSolNotional: number;
  needTclawUi: number;
  haveTclawUi: number;
  shortfallUi: number;
  suggestedSizeSol: number;
  tokenSymbol: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  walletId: string;
  prefill: RuntimeTclawBuyPrefill | null;
};

function formatUi(n: number) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '0';
  return x.toLocaleString(undefined, {
    maximumFractionDigits: 8,
  });
}

async function waitForMinTokenUiBalance(
  walletId: string,
  tokenAddress: string,
  minUi: number,
  maxWaitMs: number,
): Promise<number> {
  const epsilon = 1e-9;
  const deadline = Date.now() + maxWaitMs;
  let lastHave = 0;
  while (Date.now() < deadline) {
    const balRes = await apiRequest('POST', '/api/wallet/token-balance', {
      walletId,
      tokenAddress,
    });
    const balJson = (await balRes.json()) as {
      uiAmount?: number;
    };
    lastHave = Number(balJson.uiAmount ?? 0);
    if (lastHave + epsilon >= minUi) return lastHave;
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error(
    `Timed out waiting for wallet ${TOKEN_TICKER_DOLLAR} (have ${lastHave}, need ≥ ${formatUi(minUi)} after swap—try slightly more SOL, then retry).`,
  );
}

export function RuntimeTclawBuyDialog({ open, onOpenChange, walletId, prefill }: Props) {
  const { toast } = useToast();
  const [sizeSolStr, setSizeSolStr] = useState('0.05');

  const capitalQueryKey = [
    '/api/capital/status',
    `?walletId=${walletId}`,
  ] as const;

  const {
    data: capital,
    isPending,
    isError,
  } = useQuery({
    queryKey: [
      ...capitalQueryKey,
    ],
    enabled: Boolean(open && walletId),
    staleTime: 0,
    gcTime: 60_000,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  useEffect(() => {
    if (!prefill) return;
    const v = Math.max(0.03, Number(prefill.suggestedSizeSol) || 0.05);
    setSizeSolStr(Number(v.toFixed(4)).toString());
  }, [
    prefill,
  ]);

  const balanceSol = Number(
    (
      capital as
        | {
            balanceSol?: number;
          }
        | undefined
    )?.balanceSol ?? NaN,
  );
  const capitalReady = Boolean(open && walletId && !isPending && !isError);
  const balanceKnown = capitalReady && Number.isFinite(balanceSol);
  const spendSol = Number(sizeSolStr);
  const spendOk = Number.isFinite(spendSol) && spendSol > 0;
  const requiredTotalSol = spendOk ? spendSol + SOL_SWAP_FEE_HEADROOM : null;
  const solInsufficient = Boolean(balanceKnown && requiredTotalSol !== null && balanceSol + 1e-9 < requiredTotalSol);

  const swapAndBuy = useMutation({
    mutationFn: async () => {
      if (!prefill) {
        throw new Error('Missing plan');
      }
      const sizeSol = Number(sizeSolStr);
      if (!Number.isFinite(sizeSol) || sizeSol <= 0) {
        throw new Error('Enter a valid SOL amount');
      }

      const capRes = await apiRequest('GET', `/api/capital/status?walletId=${encodeURIComponent(walletId)}`);
      const capJson = (await capRes.json()) as {
        balanceSol?: number;
      };
      const balanceSolNow = Number(capJson.balanceSol ?? NaN);
      const requiredTotal = sizeSol + SOL_SWAP_FEE_HEADROOM;
      if (!Number.isFinite(balanceSolNow) || balanceSolNow + 1e-9 < requiredTotal) {
        throw new Error(
          `Insufficient SOL: need at least ${requiredTotal.toFixed(4)} SOL (${sizeSol.toFixed(4)} swap + ~${SOL_SWAP_FEE_HEADROOM.toFixed(3)} for fees); have ${Number.isFinite(balanceSolNow) ? balanceSolNow.toFixed(4) : 'unknown'} SOL`,
        );
      }

      const idem =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `tclaw-topup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const execRes = await apiRequest(
        'POST',
        '/api/trade/execute',
        {
          walletId,
          tokenAddress: prefill.mint,
          side: 'buy',
          sizeSol,
          slippageBps: 1000,
          symbol: prefill.tokenSymbol.slice(0, 20),
          requestedFrom: 'DASHBOARD_REQUEST',
        },
        {
          'x-idempotency-key': idem,
        },
      );
      const execBody = await execRes.json();
      if (!execBody.approved || execBody.status !== 'filled') {
        const msg =
          typeof execBody.message === 'string'
            ? execBody.message
            : typeof execBody.error === 'string'
              ? execBody.error
              : 'Swap did not complete';
        throw new Error(msg);
      }

      await waitForMinTokenUiBalance(walletId, prefill.mint, prefill.needTclawUi, 67_500);

      const purRes = await apiRequest('POST', '/api/entitlements/purchase', {
        walletId,
        planCode: prefill.plan.code,
        paymentMethod: 'tclaw',
      });
      const purBody = await purRes.json();
      if (purBody?.ok !== true && purBody?.success !== true) {
        throw new Error(
          typeof purBody.message === 'string'
            ? purBody.message
            : `Runtime purchase still failed — try Buy with ${TOKEN_TICKER_DOLLAR} again.`,
        );
      }
      return purBody;
    },
    onSuccess: () => {
      toast({
        title: `${TOKEN_TICKER_DOLLAR} acquired and runtime purchased`,
      });
      queryClient.invalidateQueries({
        queryKey: [
          '/api/entitlements/current',
        ],
      });
      queryClient.invalidateQueries({
        queryKey: [
          '/api/entitlements/plans',
        ],
      });
      queryClient.invalidateQueries({
        queryKey: [
          '/api/wallets',
        ],
      });
      queryClient.invalidateQueries({
        queryKey: [
          '/api/referral/me',
        ],
      });
      queryClient.invalidateQueries({
        queryKey: [
          '/api/capital/status',
        ],
      });
      onOpenChange(false);
    },
    onError: (err: unknown) => {
      const raw = err instanceof Error ? err.message : String(err);
      toast({
        title: 'Could not complete flow',
        description: raw,
        variant: 'destructive',
      });
    },
  });

  const swapBlocked = swapAndBuy.isPending || isPending || isError || !spendOk || solInsufficient;

  if (!prefill) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none sm:max-w-md" data-testid="dialog-runtime-tclaw-buy">
        <DialogHeader>
          <DialogTitle className="font-mono text-base uppercase tracking-tight">Get {TOKEN_TICKER_DOLLAR} for this plan</DialogTitle>
          <DialogDescription className="text-left text-sm leading-relaxed">
            This plan bills <span className="font-mono text-foreground">{formatUi(prefill.discountedSolNotional)}</span>{' '}
            SOL notionally (50% of the SOL list). At the current quote you need about{' '}
            <span className="font-mono text-foreground">{formatUi(prefill.needTclawUi)}</span> {TOKEN_TICKER_DOLLAR}. Your wallet has{' '}
            <span className="font-mono text-foreground">{formatUi(prefill.haveTclawUi)}</span>. Shortfall{' '}
            <span className="font-mono text-foreground">{formatUi(prefill.shortfallUi)}</span>.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label
            className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground"
            htmlFor="tclaw-topup-sol"
          >
            Spend SOL (swap via trade engine)
          </label>
          <Input
            id="tclaw-topup-sol"
            className={cn('rounded-none font-mono', solInsufficient && 'border-destructive ring-1 ring-destructive/80')}
            value={sizeSolStr}
            onChange={(e) => setSizeSolStr(e.target.value)}
            inputMode="decimal"
            autoComplete="off"
          />
          <p className="text-[11px] font-mono text-muted-foreground" data-testid="runtime-tclaw-dialog-sol-available">
            {isPending
              ? 'Checking SOL balance…'
              : isError
                ? 'Could not verify SOL balance.'
                : `Available SOL: ${Number.isFinite(balanceSol) ? balanceSol.toFixed(4) : '—'}${
                    requiredTotalSol != null
                      ? ` · need ≥ ${requiredTotalSol.toFixed(4)} (swap + ~${SOL_SWAP_FEE_HEADROOM.toFixed(3)} fees)`
                      : ''
                  }`}
          </p>
          {solInsufficient && requiredTotalSol != null ? (
            <p
              className="text-[11px] leading-relaxed text-destructive"
              role="alert"
              data-testid="runtime-tclaw-dialog-sol-insufficient"
            >
              Not enough SOL for this swap: {balanceSol.toFixed(4)} available, {requiredTotalSol.toFixed(4)} required
              (swap + fee buffer). Add SOL or lower the amount before continuing.
            </p>
          ) : null}
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Uses <span className="font-mono text-foreground/90">POST /api/trade/execute</span> (risk checks apply).
            After the swap settles, the UI waits until your wallet shows enough {TOKEN_TICKER_DOLLAR}, then{' '}
            <span className="font-mono text-foreground/90">POST /api/entitlements/purchase</span> transfers that {TOKEN_TICKER_DOLLAR}
            to the treasury (same idea as debiting SOL on SOL checkout).
          </p>
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" className="rounded-none" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            className="rounded-none"
            disabled={swapBlocked}
            onClick={() => swapAndBuy.mutate()}
            data-testid="button-runtime-tclaw-swap-and-buy"
          >
            {swapAndBuy.isPending ? 'Working…' : `Buy ${TOKEN_TICKER_DOLLAR} & complete runtime`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
