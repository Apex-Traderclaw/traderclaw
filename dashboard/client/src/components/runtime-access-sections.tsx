import type { Entitlement, EntitlementPlan, Wallet as WalletType } from '@shared/schema';
import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { RuntimeTclawBuyDialog, type RuntimeTclawBuyPrefill } from '@/components/runtime-tclaw-buy-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Certificate, Link2, ShoppingCart, Wallet } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { SolAmount } from '@/components/ui/solana-mark';
import { useToast } from '@/hooks/use-toast';
import { apiRequest, queryClient } from '@/lib/queryClient';
import {
  OPENCLAW_RUNTIME_HOLD_MIN_TCLAW_LABEL,
  runtimeHoldUnlimitedBalanceNote,
  runtimeHoldUnlimitedSubtitle,
  unlimitedRuntimeExplanation,
  unlimitedRuntimePlanLabel,
} from '@/lib/runtime-hold-copy';
import {
  detectBrowserSolanaWallets,
  ensureProviderConnected,
  readSignerPublicKeyBase58,
  signRuntimeHoldChallenge,
} from '@/lib/solana-browser-wallets';
import { cn } from '@/lib/utils';
import { TOKEN_TICKER, TOKEN_TICKER_DOLLAR } from '@/lib/token-config';

const planSkeletonKeys = [
  'plan-skeleton-1',
  'plan-skeleton-2',
  'plan-skeleton-3',
  'plan-skeleton-4',
];

const COUNTDOWN_UNITS = [
  {
    label: 'mo',
    seconds: 60 * 60 * 24 * 30,
  },
  {
    label: 'w',
    seconds: 60 * 60 * 24 * 7,
  },
  {
    label: 'd',
    seconds: 60 * 60 * 24,
  },
  {
    label: 'h',
    seconds: 60 * 60,
  },
  {
    label: 'm',
    seconds: 60,
  },
];

function formatRuntimeCountdown(msRemaining: number | null) {
  if (msRemaining === null) return 'INFINITE';

  let remainingSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const parts: string[] = [];

  for (const unit of COUNTDOWN_UNITS) {
    const value = Math.floor(remainingSeconds / unit.seconds);
    if (value > 0) {
      parts.push(`${value}${unit.label}`);
      remainingSeconds -= value * unit.seconds;
    }
  }

  parts.push(`${remainingSeconds}s`);
  return parts.join(' ');
}

function formatPlanAmount(amount: number) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString(undefined, {
    maximumFractionDigits: 8,
  });
}

export function RuntimeAccessSections() {
  const { toast } = useToast();
  const [now, setNow] = useState(() => Date.now());
  const { data: referralMe } = useQuery<{
    runtimeHoldMinTclaw?: number | null;
    runtimeHoldSplWalletPublicKey?: string | null;
    stakingUnlimitedRuntime?: boolean;
    holdTclawUnlimitedRuntime?: boolean;
    runtimeUnlimited?: boolean;
    runtimeTclawPurchaseEnabled?: boolean;
    runtimeHoldTclawMint?: string | null;
  } | null>({
    queryKey: [
      '/api/referral/me',
    ],
  });
  const stakingUnlimitedRuntime = Boolean(referralMe?.stakingUnlimitedRuntime);
  const holdTclawUnlimitedRuntime = Boolean(referralMe?.holdTclawUnlimitedRuntime);
  const referralRuntimeUnlimited = Boolean(
    referralMe?.runtimeUnlimited ?? (stakingUnlimitedRuntime || holdTclawUnlimitedRuntime),
  );
  const holdMinRaw = referralMe?.runtimeHoldMinTclaw;
  const holdMin =
    holdMinRaw != null && Number.isFinite(Number(holdMinRaw)) && Number(holdMinRaw) > 0 ? Number(holdMinRaw) : null;
  const tclawPurchaseEnabled = Boolean(referralMe?.runtimeTclawPurchaseEnabled);
  const tclawMint = referralMe?.runtimeHoldTclawMint?.trim() ?? '';
  const { data: wallets } = useQuery<WalletType[] | null>({
    queryKey: [
      '/api/wallets',
    ],
  });
  const wallet = wallets?.[0];
  const isUnauthorized = wallets === null;
  const hasWallet = Array.isArray(wallets) && wallets.length > 0;

  const [purchaseRail, setPurchaseRail] = useState<'sol' | 'tclaw'>('sol');

  useEffect(() => {
    if (!tclawPurchaseEnabled && purchaseRail === 'tclaw') {
      setPurchaseRail('sol');
    }
  }, [
    tclawPurchaseEnabled,
    purchaseRail,
  ]);

  const { data: plans, isLoading: plansLoading } = useQuery<EntitlementPlan[]>({
    queryKey: [
      '/api/entitlements/plans',
    ],
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/entitlements/plans');
      const payload = await res.json();
      if (Array.isArray(payload)) return payload;
      if (Array.isArray(payload?.plans)) return payload.plans;
      return [];
    },
  });

  const { data: currentData, isLoading: currentLoading } = useQuery<{
    limits: Record<string, number>;
    activeEntitlements: Entitlement[];
  }>({
    queryKey: [
      '/api/entitlements/current',
      wallet?.id ? `?walletId=${wallet.id}` : '',
    ],
    enabled: !!wallet?.id,
    queryFn: async ({ queryKey }) => {
      const [, search] = queryKey as [
        string,
        string,
      ];
      const res = await apiRequest('GET', `/api/entitlements/current${search || ''}`);
      const payload = await res.json();
      return {
        limits: payload?.effectiveLimits ?? payload?.limits ?? {},
        activeEntitlements: payload?.active ?? payload?.activeEntitlements ?? [],
      };
    },
  });

  const planList = plans ?? [];
  const tclawPlanQuotes = useQueries({
    queries: planList.map((plan) => {
      const listSol = Number(plan.priceSol ?? 0);
      const discountedSol = (listSol * 5) / 10;
      return {
        queryKey: [
          '/api/trade/quote-by-pubkey',
          plan.code,
          wallet?.id ?? '',
          tclawMint,
          discountedSol,
          purchaseRail,
        ] as const,
        enabled:
          purchaseRail === 'tclaw' &&
          tclawPurchaseEnabled &&
          Boolean(wallet?.publicKey) &&
          Boolean(tclawMint) &&
          discountedSol > 0 &&
          !isUnauthorized,
        staleTime: 45_000,
        queryFn: async () => {
          const res = await apiRequest('POST', '/api/trade/quote-by-pubkey', {
            publicKey: wallet!.publicKey,
            tokenAddress: tclawMint,
            side: 'buy',
            sizeSol: discountedSol,
            slippageBps: 150,
          });
          const body = (await res.json()) as {
            ok?: boolean;
            quote?: { estimatedTokensOut?: number };
            message?: string;
          };
          if (!res.ok || body?.ok !== true) {
            throw new Error(body?.message || `Quote failed (${res.status})`);
          }
          return Number(body.quote?.estimatedTokensOut ?? NaN);
        },
      };
    }),
  });

  const purchaseMutation = useMutation({
    mutationFn: async ({ planCode, paymentMethod }: { planCode: string; paymentMethod: 'sol' | 'tclaw' }) => {
      const res = await apiRequest('POST', '/api/entitlements/purchase', {
        walletId: wallet?.id,
        planCode,
        paymentMethod,
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data?.ok === true || data?.success === true) {
        toast({
          title: 'Runtime purchased',
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
            '/api/capital/status',
          ],
        });
        queryClient.invalidateQueries({
          queryKey: [
            '/api/referral/me',
          ],
        });
      } else {
        toast({
          title: 'Purchase failed',
          description: data?.message || data?.error || 'Unexpected purchase response',
          variant: 'destructive',
        });
      }
    },
    onError: (err: unknown) => {
      const raw = err instanceof Error ? err.message : String(err);
      const nl = raw.indexOf('\n');
      if (nl > 0) {
        toast({
          title: raw.slice(0, nl).trim(),
          description: raw.slice(nl + 1).trim(),
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Error',
          description: raw,
          variant: 'destructive',
        });
      }
    },
  });

  const [tclawTopUp, setTclawTopUp] = useState<RuntimeTclawBuyPrefill | null>(null);
  const [tclawBuyChecking, setTclawBuyChecking] = useState<string | null>(null);

  const onTclawBuyClick = async (plan: EntitlementPlan) => {
    const mint = tclawMint;
    if (!wallet?.id || !wallet.publicKey || !mint || !tclawPurchaseEnabled) return;
    const listSol = Number(plan.priceSol ?? 0);
    const discountedSol = (listSol * 5) / 10;
    if (!(discountedSol > 0)) {
      purchaseMutation.mutate({
        planCode: plan.code,
        paymentMethod: 'tclaw',
      });
      return;
    }
    setTclawBuyChecking(plan.code);
    try {
      const quoteRes = await apiRequest('POST', '/api/trade/quote-by-pubkey', {
        publicKey: wallet.publicKey,
        tokenAddress: mint,
        side: 'buy',
        sizeSol: discountedSol,
        slippageBps: 150,
      });
      const quoteBody = (await quoteRes.json()) as {
        ok?: boolean;
        quote?: {
          estimatedTokensOut?: number;
        };
        message?: string;
      };
      if (!quoteRes.ok || quoteBody?.ok !== true) {
        throw new Error(quoteBody?.message || `Quote failed (${quoteRes.status})`);
      }
      const need = Number(quoteBody.quote?.estimatedTokensOut ?? NaN);
      if (!Number.isFinite(need) || need <= 0) {
        throw new Error(`Swap quote did not return a valid ${TOKEN_TICKER_DOLLAR} amount`);
      }

      const balRes = await apiRequest('POST', '/api/wallet/token-balance', {
        walletId: wallet.id,
        tokenAddress: mint,
      });
      const balJson = (await balRes.json()) as {
        uiAmount?: number;
      };
      const have = Number(balJson.uiAmount ?? 0);
      if (have + 1e-9 >= need) {
        purchaseMutation.mutate({
          planCode: plan.code,
          paymentMethod: 'tclaw',
        });
        return;
      }
      const shortfall = need - have;
      let tokenSymbol = TOKEN_TICKER;
      const suggestedSizeSol = Math.max(0.03, need > 0 ? (shortfall / need) * discountedSol : discountedSol);
      try {
        const snapRes = await apiRequest('POST', '/api/token/snapshot', {
          tokenAddress: mint,
        });
        const snap = (await snapRes.json()) as {
          symbol?: string;
        };
        if (typeof snap.symbol === 'string' && snap.symbol.trim()) {
          tokenSymbol = snap.symbol.trim();
        }
      } catch {
        /* label only */
      }
      setTclawTopUp({
        plan,
        mint,
        discountedSolNotional: discountedSol,
        needTclawUi: need,
        haveTclawUi: have,
        shortfallUi: shortfall,
        suggestedSizeSol: Number(suggestedSizeSol.toFixed(4)),
        tokenSymbol,
      });
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      toast({
        title: `Could not price ${TOKEN_TICKER_DOLLAR} checkout`,
        description: raw,
        variant: 'destructive',
      });
    } finally {
      setTclawBuyChecking(null);
    }
  };

  const [linkedSplDraft, setLinkedSplDraft] = useState('');
  useEffect(() => {
    setLinkedSplDraft(referralMe?.runtimeHoldSplWalletPublicKey ?? '');
  }, [
    referralMe?.runtimeHoldSplWalletPublicKey,
  ]);

  const browserSolProviders = useMemo(() => detectBrowserSolanaWallets(), []);

  const clearLinkedSplMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('PUT', '/api/access/runtime-hold-wallet', {
        splWalletPublicKey: null,
      });
      await res.json();
    },
    onSuccess: async () => {
      setLinkedSplDraft('');
      toast({
        title: 'Linked wallet cleared',
      });
      await queryClient.invalidateQueries({
        queryKey: [
          '/api/referral/me',
        ],
      });
    },
    onError: (err: unknown) => {
      const raw = err instanceof Error ? err.message : String(err);
      toast({
        title: 'Could not clear linked wallet',
        description: raw,
        variant: 'destructive',
      });
    },
  });

  const verifyLinkSplMutation = useMutation({
    mutationFn: async (choice: ReturnType<typeof detectBrowserSolanaWallets>[0]) => {
      const { provider, label } = choice;
      await ensureProviderConnected(provider);
      const signerPk = readSignerPublicKeyBase58(provider).trim();
      const draft = linkedSplDraft.trim();
      const targetPk = draft || signerPk;
      if (signerPk !== targetPk) {
        throw new Error(
          `Active ${label} account does not match the address in the box. Switch the wallet to ${targetPk.slice(0, 6)}… or clear the field to use ${signerPk.slice(0, 6)}…`,
        );
      }
      const chRes = await apiRequest('POST', '/api/access/runtime-hold-wallet/challenge', {
        splWalletPublicKey: targetPk,
      });
      const chTxt = await chRes.text().catch(() => '');
      let chPayload: {
        challenge?: string;
        challengeId?: string;
      } = {};
      try {
        chPayload = chTxt ? (JSON.parse(chTxt) as typeof chPayload) : {};
      } catch {
        chPayload = {};
      }
      if (!chRes.ok) {
        throw new Error(`${chTxt || chRes.statusText}`.slice(0, 400));
      }
      if (!chPayload.challenge || !chPayload.challengeId) {
        throw new Error('Verification challenge incomplete');
      }
      const signed = await signRuntimeHoldChallenge(provider, chPayload.challenge);
      if (signed.signerPublicKey && signed.signerPublicKey.trim() !== targetPk) {
        throw new Error('Signer key mismatch — try reconnecting your wallet.');
      }
      const putRes = await apiRequest('PUT', '/api/access/runtime-hold-wallet', {
        splWalletPublicKey: targetPk,
        challengeId: chPayload.challengeId,
        walletSignature: signed.walletSignature,
      });
      const putTxt = await putRes.text().catch(() => '');
      if (!putRes.ok) throw new Error(`${putTxt || putRes.statusText}`.slice(0, 400));
      let body: {
        ok?: boolean;
        runtimeHoldSplWalletPublicKey?: string | null;
      } = {};
      try {
        body = putTxt ? (JSON.parse(putTxt) as typeof body) : {};
      } catch {
        body = {};
      }
      return body;
    },
    onSuccess: async (data) => {
      const pk = data?.runtimeHoldSplWalletPublicKey ?? '';
      if (pk) setLinkedSplDraft(pk);
      toast({
        title: 'Wallet verified and linked',
      });
      await queryClient.invalidateQueries({
        queryKey: [
          '/api/referral/me',
        ],
      });
    },
    onError: (err: unknown) => {
      const raw = err instanceof Error ? err.message : String(err);
      toast({
        title: 'Could not verify wallet',
        description: raw,
        variant: 'destructive',
      });
    },
  });

  const activeRuntime = currentData?.activeEntitlements ?? [];

  useEffect(() => {
    if (!activeRuntime.length) return;
    const hasFiniteExpiry = activeRuntime.some((ent) => Number.isFinite(new Date(ent.expiresAt).getTime()));
    if (!hasFiniteExpiry) return;

    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [
    activeRuntime,
  ]);

  const activeRuntimeMeta = useMemo(() => {
    return activeRuntime.map((ent) => {
      const expiresMs = ent.expiresAt ? new Date(ent.expiresAt).getTime() : NaN;
      const isInfinite = !Number.isFinite(expiresMs);
      const msRemaining = isInfinite ? null : Math.max(0, expiresMs - now);
      const plan = plans?.find((p) => p.code === ent.planCode);
      const totalHours = plan?.durationHours ?? 24;
      const totalMs = totalHours * 60 * 60 * 1000;
      const pct = isInfinite
        ? 100
        : totalMs > 0 && msRemaining !== null
          ? Math.max(0, Math.min(100, (msRemaining / totalMs) * 100))
          : 0;

      return {
        ent,
        plan,
        isInfinite,
        expiresMs,
        msRemaining,
        pct,
      };
    });
  }, [
    activeRuntime,
    now,
    plans,
  ]);

  const runtimeRemainingLabel = useMemo(() => {
    if (referralRuntimeUnlimited) {
      return 'INFINITE';
    }
    if (!activeRuntimeMeta.length) {
      return '0s';
    }
    if (activeRuntimeMeta.some((entry) => entry.isInfinite)) {
      return 'INFINITE';
    }
    const longestMs = Math.max(...activeRuntimeMeta.map((entry) => entry.msRemaining ?? 0));
    return formatRuntimeCountdown(longestMs);
  }, [
    referralRuntimeUnlimited,
    activeRuntimeMeta,
  ]);

  const primaryActivePlan = useMemo(() => {
    if (referralRuntimeUnlimited) {
      return unlimitedRuntimePlanLabel({
        stakingUnlimitedRuntime,
        holdTclawUnlimitedRuntime,
      });
    }
    return activeRuntime[0]?.planCode?.replace(/_/g, ' ') ?? 'None active';
  }, [
    referralRuntimeUnlimited,
    activeRuntime,
    stakingUnlimitedRuntime,
    holdTclawUnlimitedRuntime,
  ]);

  return (
    <div className="space-y-8">
      <section className="grid grid-cols-1 gap-4 xl:grid-cols-3" data-testid="section-runtime-summary">
        <Card>
          <CardContent className="space-y-2 p-4">
            <div
              className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
              style={{
                fontFamily: 'var(--font-mono)',
              }}
            >
              Active Plan
            </div>
            <div className="text-base text-foreground">{primaryActivePlan}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-2 p-4">
            <div
              className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
              style={{
                fontFamily: 'var(--font-mono)',
              }}
            >
              Runtime Remaining
            </div>
            <div
              className="text-sm leading-snug text-foreground"
              style={{
                fontFamily: 'var(--font-mono)',
              }}
              data-testid="text-runtime-remaining-countdown"
            >
              {runtimeRemainingLabel}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-2 p-4">
            <div
              className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
              style={{
                fontFamily: 'var(--font-mono)',
              }}
            >
              Payment Rails
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className="text-[10px]">
                SOL live
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {TOKEN_TICKER_DOLLAR} staged
              </Badge>
            </div>
          </CardContent>
        </Card>
      </section>

      {hasWallet && !isUnauthorized && holdMin != null ? (
        <section className="space-y-2" data-testid="section-runtime-linked-wallet">
          <Card className="border-border/70">
            <CardContent className="space-y-3 p-4">
              <div
                className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
                style={{
                  fontFamily: 'var(--font-mono)',
                }}
              >
                Optional · {TOKEN_TICKER_DOLLAR} balance address
              </div>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Link the Solana address where you custody SPL {TOKEN_TICKER_DOLLAR}. Unlimited runtime via this gate uses only {TOKEN_TICKER_DOLLAR}
                held on that linked address — we do not look at TraderClaw trading wallets, and balances are checked on
                each gated request.
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground/90">
                You must prove you control this address by signing one short message with Phantom, Solflare, Backpack,
                or another compatible browser wallet. Leave the field blank to verify with whatever account your wallet
                is using; paste an address before signing to enforce that extension account.
              </p>
              <p className="text-[11px] leading-relaxed text-muted-foreground/90">
                {runtimeHoldUnlimitedBalanceNote()}
              </p>
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    data-testid="input-runtime-linked-spl-wallet"
                    className="font-mono text-xs sm:min-w-0 sm:flex-1"
                    placeholder="Solana pubkey (optional — restricts which account signs)"
                    value={linkedSplDraft}
                    onChange={(e) => {
                      setLinkedSplDraft(e.target.value);
                    }}
                    disabled={verifyLinkSplMutation.isPending || clearLinkedSplMutation.isPending}
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                  <div className="flex flex-wrap gap-2">
                    {browserSolProviders.length ? (
                      browserSolProviders.map((w, i) => (
                        <Button
                          key={w.id}
                          size="sm"
                          className="text-xs"
                          data-testid={
                            i === 0
                              ? 'button-runtime-save-linked-wallet'
                              : `button-runtime-verify-linked-wallet-${w.id}`
                          }
                          disabled={verifyLinkSplMutation.isPending || clearLinkedSplMutation.isPending}
                          type="button"
                          onClick={() => {
                            void verifyLinkSplMutation.mutate(w);
                          }}
                        >
                          Verify with {w.label}
                        </Button>
                      ))
                    ) : (
                      <p className="text-[11px] text-muted-foreground">
                        Install a Solana wallet (e.g. Phantom or Solflare) in this browser, then reload to verify.
                      </p>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs"
                      type="button"
                      disabled={
                        verifyLinkSplMutation.isPending ||
                        clearLinkedSplMutation.isPending ||
                        !referralMe?.runtimeHoldSplWalletPublicKey
                      }
                      onClick={() => {
                        void clearLinkedSplMutation.mutate();
                      }}
                    >
                      Clear
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>
      ) : null}

      <section className="space-y-3" data-testid="section-runtime-active">
        <div className="space-y-1">
          <div
            className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground"
            style={{
              fontFamily: 'var(--font-mono)',
            }}
          >
            Runtime
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2
              className="text-sm font-medium uppercase tracking-[0.08em]"
              style={{
                fontFamily: 'var(--font-mono)',
              }}
            >
              Active Runtime
            </h2>
            <Badge variant="outline" className="text-[10px]">
              {referralRuntimeUnlimited && activeRuntime.length === 0
                ? 'Unlimited · active'
                : referralRuntimeUnlimited && activeRuntime.length > 0
                  ? `${activeRuntime.length} plan(s)`
                  : `${activeRuntime.length} active`}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            This area shows which runtime plan is active on the current wallet and how long it has left.
          </p>
        </div>

        {currentLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : isUnauthorized ? (
          <Card>
            <CardContent className="p-5">
              <EmptyState
                icon={Link2}
                title="Session disconnected"
                description="Re-sync your API session to view active runtime."
                compact
                framed={false}
              />
            </CardContent>
          </Card>
        ) : !hasWallet ? (
          <Card>
            <CardContent className="p-5">
              <EmptyState
                icon={Wallet}
                title="No wallet found"
                description="Create a wallet to activate runtime and view active plans."
                compact
                framed={false}
              />
            </CardContent>
          </Card>
        ) : !activeRuntime.length && !referralRuntimeUnlimited ? (
          <Card>
            <CardContent className="p-5">
              <EmptyState
                icon={Certificate}
                title="No active runtime"
                description={
                  <span className="space-y-2 text-sm text-muted-foreground">
                    <span className="block">Buy a runtime plan below to activate execution time on this account.</span>
                    {holdMin != null ? (
                      <span className="block text-left text-muted-foreground">
                        <span className="block text-foreground/90">{runtimeHoldUnlimitedSubtitle(holdMin)}</span>
                        <span className="mt-1 block font-mono text-[10px] tracking-tight">
                          Threshold from {OPENCLAW_RUNTIME_HOLD_MIN_TCLAW_LABEL} when hold-unlimited is enabled on the
                          API.
                        </span>
                        <span className="mt-2 block text-[11px] leading-relaxed">
                          {runtimeHoldUnlimitedBalanceNote()}
                        </span>
                      </span>
                    ) : null}
                  </span>
                }
                compact
                framed={false}
              />
            </CardContent>
          </Card>
        ) : !activeRuntime.length && referralRuntimeUnlimited ? (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <Card data-testid="card-active-runtime-unlimited">
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="space-y-1">
                    <div
                      className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
                      style={{
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      Current Plan
                    </div>
                    <div className="text-sm font-medium text-foreground">
                      {unlimitedRuntimePlanLabel({
                        stakingUnlimitedRuntime,
                        holdTclawUnlimitedRuntime,
                      })}
                    </div>
                  </div>
                  <Badge variant="outline" className="border-primary/40 text-[10px] text-primary">
                    INFINITE
                  </Badge>
                </div>
                <Progress value={100} className="h-1.5" />
                <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                  <span>Remaining</span>
                  <span
                    className="font-mono text-[10px]"
                    style={{
                      color: 'hsl(var(--primary))',
                    }}
                  >
                    INFINITE
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                  <span>Ends</span>
                  <span className="font-mono text-[10px] text-foreground">No expiry</span>
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {unlimitedRuntimeExplanation({
                    stakingUnlimitedRuntime,
                    holdTclawUnlimitedRuntime,
                  })}
                </p>
              </CardContent>
            </Card>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {activeRuntimeMeta.map(({ ent, isInfinite, msRemaining, pct }) => {
              return (
                <Card key={ent.id} data-testid={`card-active-runtime-${ent.id}`}>
                  <CardContent className="space-y-3 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="space-y-1">
                        <div
                          className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
                          style={{
                            fontFamily: 'var(--font-mono)',
                          }}
                        >
                          Current Plan
                        </div>
                        <div className="text-sm font-medium text-foreground">{ent.planCode.replace(/_/g, ' ')}</div>
                      </div>
                      <Badge variant="outline" className="text-[10px]">
                        {isInfinite ? 'INFINITE' : formatRuntimeCountdown(msRemaining)}
                      </Badge>
                    </div>
                    <Progress value={pct} className="h-1.5" />
                    <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                      <span>Remaining</span>
                      <span
                        className="font-mono text-[10px]"
                        style={{
                          color: isInfinite ? 'hsl(var(--primary))' : 'hsl(var(--foreground))',
                        }}
                      >
                        {isInfinite ? 'INFINITE' : formatRuntimeCountdown(msRemaining)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                      <span>Ends</span>
                      <span className="font-mono text-[10px] text-foreground">
                        {isInfinite ? 'No expiry' : new Date(ent.expiresAt).toLocaleString()}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-3" data-testid="section-runtime-buy">
        <div className="space-y-1">
          <div
            className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground"
            style={{
              fontFamily: 'var(--font-mono)',
            }}
          >
            Runtime
          </div>
          <h2
            className="text-sm font-medium uppercase tracking-[0.08em]"
            style={{
              fontFamily: 'var(--font-mono)',
            }}
          >
            Buy Runtime
          </h2>
          <p className="text-sm text-muted-foreground">
            {tclawPurchaseEnabled ? (
              <>
                Buy runtime with SOL at the listed price, or pay in {TOKEN_TICKER_DOLLAR} using a{' '}
                <span className="text-foreground/90">live Jupiter quote</span> on{' '}
                <span className="text-foreground/90">50% of the SOL list price</span> for the same plan (SPL debit from
                this TraderClaw wallet).
              </>
            ) : (
              <>
                Buy runtime with SOL today. The {TOKEN_TICKER_DOLLAR} purchase rail turns on when{' '}
                <span className="font-mono text-[11px] text-muted-foreground/90">OPENCLAW_RUNTIME_HOLD_TCLAW_MINT</span>{' '}
                is set on the API.
              </>
            )}{' '}
            {holdMin != null ? (
              <>
                <span className="text-foreground/90">{runtimeHoldUnlimitedSubtitle(holdMin)}</span>{' '}
                <span className="font-mono text-[11px] text-muted-foreground/90">
                  ({OPENCLAW_RUNTIME_HOLD_MIN_TCLAW_LABEL})
                </span>
              </>
            ) : null}
          </p>
          {holdMin != null ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">{runtimeHoldUnlimitedBalanceNote()}</p>
          ) : null}
        </div>

        {plansLoading ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            {planSkeletonKeys.map((key) => (
              <Skeleton key={key} className="h-52 w-full" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            {plans?.map((plan, planIndex) => {
              const listSol = Number(plan.priceSol ?? 0);
              const halfTclaw = (listSol * 5) / 10;
              const tclawQuoteState = tclawPlanQuotes[planIndex];
              const tclawQuotedUi = tclawQuoteState?.data;
              const tclawQuoteLoading =
                purchaseRail === 'tclaw' &&
                tclawPurchaseEnabled &&
                Boolean(tclawQuoteState?.isPending);
              return (
                <Card key={plan.code} data-testid={`card-runtime-plan-${plan.code}`}>
                  <CardHeader className="space-y-3 pb-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1.5">
                        <div
                          className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground"
                          style={{
                            fontFamily: 'var(--font-mono)',
                          }}
                        >
                          Runtime Plan
                        </div>
                        <CardTitle className="text-base">{plan.name}</CardTitle>
                      </div>
                      {purchaseRail === 'sol' ? (
                        <SolAmount
                          value={formatPlanAmount(listSol)}
                          className="text-sm font-mono font-bold"
                          valueClassName="text-primary"
                          markClassName="h-3.5 w-3.5"
                        />
                      ) : (
                        <span className="inline-flex items-baseline gap-2">
                          <span className="text-sm font-mono font-bold text-primary">
                            {tclawQuoteLoading ? (
                              '…'
                            ) : Number.isFinite(tclawQuotedUi) && Number(tclawQuotedUi) > 0 ? (
                              formatPlanAmount(Number(tclawQuotedUi))
                            ) : (
                              '—'
                            )}
                          </span>
                          <span className="text-[9px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                            {TOKEN_TICKER_DOLLAR}
                          </span>
                          {halfTclaw > 0 && listSol > 0 ? (
                            <span className="text-[9px] text-muted-foreground/80">−50%</span>
                          ) : null}
                        </span>
                      )}
                    </div>
                  </CardHeader>

                  <CardContent className="space-y-4 pt-0">
                    <p className="text-sm leading-6 text-muted-foreground">{plan.description}</p>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline" className="text-[10px]">
                        {plan.durationHours}h runtime
                      </Badge>
                      {plan.stackable ? (
                        <Badge variant="outline" className="text-[10px]">
                          Stackable (max {plan.maxStack})
                        </Badge>
                      ) : null}
                      {plan.autoRenewAllowed ? (
                        <Badge variant="outline" className="text-[10px]">
                          Auto-renew
                        </Badge>
                      ) : null}
                    </div>
                    <div className="border border-border/70 bg-muted/10 px-3 py-2.5">
                      <div
                        className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground"
                        style={{
                          fontFamily: 'var(--font-mono)',
                        }}
                      >
                        Payment
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          className={cn(
                            'rounded-none border px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.12em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            purchaseRail === 'sol'
                              ? 'border-primary bg-primary/15 text-foreground'
                              : 'border-border/60 bg-background/40 text-muted-foreground hover:bg-muted/30',
                          )}
                          onClick={() => setPurchaseRail('sol')}
                          data-testid={`button-payment-rail-sol-${plan.code}`}
                        >
                          SOL live
                        </button>
                        <button
                          type="button"
                          disabled={!tclawPurchaseEnabled}
                          className={cn(
                            'rounded-none border px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.12em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            purchaseRail === 'tclaw'
                              ? 'border-primary bg-primary/15 text-foreground'
                              : 'border-border/60 bg-background/40 text-muted-foreground hover:bg-muted/30',
                            !tclawPurchaseEnabled ? 'cursor-not-allowed opacity-55' : null,
                          )}
                          onClick={() => tclawPurchaseEnabled && setPurchaseRail('tclaw')}
                          data-testid={`button-payment-rail-tclaw-${plan.code}`}
                        >
                          {tclawPurchaseEnabled ? `${TOKEN_TICKER_DOLLAR} live` : `${TOKEN_TICKER_DOLLAR} soon`}
                        </button>
                      </div>
                      {tclawPurchaseEnabled ? (
                        <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                          {TOKEN_TICKER_DOLLAR} checkout uses the same SPL mint as runtime hold. Amount charged is{' '}
                          <span className="font-mono text-foreground/90">50%</span> of the SOL list for this plan (0
                          stays free).
                        </p>
                      ) : null}
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <Button
                        data-testid={`button-runtime-sol-${plan.code}`}
                        size="sm"
                        className="w-full text-xs"
                        onClick={() =>
                          purchaseMutation.mutate({
                            planCode: plan.code,
                            paymentMethod: 'sol',
                          })
                        }
                        disabled={purchaseMutation.isPending || !hasWallet || isUnauthorized}
                      >
                        <ShoppingCart className="mr-1 h-3.5 w-3.5" />
                        Buy with SOL
                      </Button>
                      <Button
                        data-testid={`button-runtime-tclaw-${plan.code}`}
                        size="sm"
                        variant="outline"
                        className="w-full text-xs"
                        onClick={() => void onTclawBuyClick(plan)}
                        disabled={
                          purchaseMutation.isPending ||
                          !hasWallet ||
                          isUnauthorized ||
                          !tclawPurchaseEnabled ||
                          tclawBuyChecking === plan.code
                        }
                      >
                        Buy with {TOKEN_TICKER_DOLLAR}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>
      <RuntimeTclawBuyDialog
        open={tclawTopUp != null && Boolean(wallet?.id)}
        onOpenChange={(next) => {
          if (!next) setTclawTopUp(null);
        }}
        walletId={wallet?.id != null ? String(wallet.id) : ''}
        prefill={tclawTopUp}
      />
    </div>
  );
}
