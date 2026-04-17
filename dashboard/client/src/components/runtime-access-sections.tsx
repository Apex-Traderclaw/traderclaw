import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { SolAmount } from "@/components/ui/solana-mark";
import { Certificate, Clock, Link2, ShoppingCart, Wallet } from "@/components/ui/icons";
import { useToast } from "@/hooks/use-toast";
import type { Wallet as WalletType, EntitlementPlan, Entitlement } from "@shared/schema";

const planSkeletonKeys = ["plan-skeleton-1", "plan-skeleton-2", "plan-skeleton-3", "plan-skeleton-4"];

const COUNTDOWN_UNITS = [
  { label: "mo", seconds: 60 * 60 * 24 * 30 },
  { label: "w", seconds: 60 * 60 * 24 * 7 },
  { label: "d", seconds: 60 * 60 * 24 },
  { label: "h", seconds: 60 * 60 },
  { label: "m", seconds: 60 },
];

function formatRuntimeCountdown(msRemaining: number | null) {
  if (msRemaining === null) return "INFINITE";

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
  return parts.join(" ");
}

export function RuntimeAccessSections() {
  const { toast } = useToast();
  const [now, setNow] = useState(() => Date.now());
  const { data: wallets } = useQuery<WalletType[] | null>({ queryKey: ["/api/wallets"] });
  const wallet = wallets?.[0];
  const isUnauthorized = wallets === null;
  const hasWallet = Array.isArray(wallets) && wallets.length > 0;

  const { data: plans, isLoading: plansLoading } = useQuery<EntitlementPlan[]>({
    queryKey: ["/api/entitlements/plans"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/entitlements/plans");
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
    queryKey: ["/api/entitlements/current", wallet?.id ? `?walletId=${wallet.id}` : ""],
    enabled: !!wallet?.id,
    queryFn: async ({ queryKey }) => {
      const [, search] = queryKey as [string, string];
      const res = await apiRequest("GET", `/api/entitlements/current${search || ""}`);
      const payload = await res.json();
      return {
        limits: payload?.effectiveLimits ?? payload?.limits ?? {},
        activeEntitlements: payload?.active ?? payload?.activeEntitlements ?? [],
      };
    },
  });

  const purchaseMutation = useMutation({
    mutationFn: async (planCode: string) => {
      const res = await apiRequest("POST", "/api/entitlements/purchase", {
        walletId: wallet?.id,
        planCode,
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data?.ok === true || data?.success === true) {
        toast({ title: "Runtime purchased" });
        queryClient.invalidateQueries({ queryKey: ["/api/entitlements/current"] });
        queryClient.invalidateQueries({ queryKey: ["/api/entitlements/plans"] });
        queryClient.invalidateQueries({ queryKey: ["/api/wallets"] });
        queryClient.invalidateQueries({ queryKey: ["/api/capital/status"] });
      } else {
        toast({
          title: "Purchase failed",
          description: data?.message || data?.error || "Unexpected purchase response",
          variant: "destructive",
        });
      }
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const activeRuntime = currentData?.activeEntitlements ?? [];

  useEffect(() => {
    if (!activeRuntime.length) return;
    const hasFiniteExpiry = activeRuntime.some((ent) => Number.isFinite(new Date(ent.expiresAt).getTime()));
    if (!hasFiniteExpiry) return;

    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [activeRuntime]);

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
  }, [activeRuntime, now, plans]);

  const runtimeRemainingLabel = useMemo(() => {
    if (!activeRuntimeMeta.length) return "0s";
    if (activeRuntimeMeta.some((entry) => entry.isInfinite)) return "INFINITE";
    const longestMs = Math.max(...activeRuntimeMeta.map((entry) => entry.msRemaining ?? 0));
    return formatRuntimeCountdown(longestMs);
  }, [activeRuntimeMeta]);

  const primaryActivePlan = activeRuntime[0]?.planCode?.replace(/_/g, " ") ?? "None active";

  return (
    <div className="space-y-8">
      <section className="grid grid-cols-1 gap-4 xl:grid-cols-3" data-testid="section-runtime-summary">
        <Card>
          <CardContent className="space-y-2 p-4">
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
              Active Plan
            </div>
            <div className="text-base text-foreground">{primaryActivePlan}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-2 p-4">
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
              Runtime Remaining
            </div>
            <div
              className="text-sm leading-snug text-foreground"
              style={{ fontFamily: "var(--font-mono)" }}
              data-testid="text-runtime-remaining-countdown"
            >
              {runtimeRemainingLabel}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-2 p-4">
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
              Payment Rails
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className="text-[10px]">SOL live</Badge>
              <Badge variant="outline" className="text-[10px]">$TCLAW staged</Badge>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3" data-testid="section-runtime-active">
        <div className="space-y-1">
          <div
            className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            Runtime
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium uppercase tracking-[0.08em]" style={{ fontFamily: "var(--font-mono)" }}>
              Active Runtime
            </h2>
            <Badge variant="outline" className="text-[10px]">
              {activeRuntime.length} active
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
        ) : !activeRuntime.length ? (
          <Card>
            <CardContent className="p-5">
              <EmptyState
                icon={Certificate}
                title="No active runtime"
                description="Buy a runtime plan below to activate execution time on this account."
                compact
                framed={false}
              />
            </CardContent>
          </Card>
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
                          style={{ fontFamily: "var(--font-mono)" }}
                        >
                          Current Plan
                        </div>
                        <div className="text-sm font-medium text-foreground">{ent.planCode.replace(/_/g, " ")}</div>
                      </div>
                      <Badge variant="outline" className="text-[10px]">
                        {isInfinite ? "INFINITE" : formatRuntimeCountdown(msRemaining)}
                      </Badge>
                    </div>
                    <Progress value={pct} className="h-1.5" />
                    <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                      <span>Remaining</span>
                      <span
                        className="font-mono text-[10px]"
                        style={{ color: isInfinite ? "hsl(var(--primary))" : "hsl(var(--foreground))" }}
                      >
                        {isInfinite ? "INFINITE" : formatRuntimeCountdown(msRemaining)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                      <span>Ends</span>
                      <span className="font-mono text-[10px] text-foreground">
                        {isInfinite ? "No expiry" : new Date(ent.expiresAt).toLocaleString()}
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
            style={{ fontFamily: "var(--font-mono)" }}
          >
            Runtime
          </div>
          <h2 className="text-sm font-medium uppercase tracking-[0.08em]" style={{ fontFamily: "var(--font-mono)" }}>
            Buy Runtime
          </h2>
          <p className="text-sm text-muted-foreground">
            Buy runtime with SOL today. The $TCLAW purchase rail is shown here as the staged token flow for the same plans.
          </p>
        </div>

        {plansLoading ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {planSkeletonKeys.map((key) => (
              <Skeleton key={key} className="h-52 w-full" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {plans?.map((plan) => (
              <Card key={plan.code} data-testid={`card-runtime-plan-${plan.code}`}>
                <CardHeader className="space-y-3 pb-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1.5">
                      <div
                        className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground"
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        Runtime Plan
                      </div>
                      <CardTitle className="text-base">{plan.name}</CardTitle>
                    </div>
                    <SolAmount
                      value={plan.priceSol}
                      className="text-sm font-mono font-bold"
                      valueClassName="text-primary"
                      markClassName="h-3.5 w-3.5"
                    />
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
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      Payment
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2">
                      <Badge variant="outline" className="text-[10px]">SOL live</Badge>
                      <Badge variant="outline" className="text-[10px]">$TCLAW soon</Badge>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <Button
                      data-testid={`button-runtime-sol-${plan.code}`}
                      size="sm"
                      className="w-full text-xs"
                      onClick={() => purchaseMutation.mutate(plan.code)}
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
                      disabled
                    >
                      Buy with $TCLAW
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
