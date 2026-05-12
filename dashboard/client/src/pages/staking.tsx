import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { ArrowUpRight, CheckCircle2, Clock, Link2, Lock, ShoppingCart, Sparkles, Unlock, Wallet } from "@/components/ui/icons";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Wallet as WalletType } from "@shared/schema";
import { TOKEN_TICKER } from "@/lib/token-config";

type StakeEvent = {
  id: string;
  type: "connect" | "stake" | "unstake" | "claim";
  label: string;
  amount?: number;
  timestamp: string;
};

type WalletSource = "dashboard" | "external";

type ConnectedWalletView = {
  key: string;
  label: string;
  publicKey: string;
  source: WalletSource;
};

type TierDef = {
  name: string;
  min: number;
  discountPct: number;
};

type StakingEntitlementsResponse = {
  ok: boolean;
  staking: {
    linkedWallet: string | null;
    stakedBalance: number;
    rawTier: string | null;
    activeTier: string | null;
    discountPct: number;
    unlimitedRuntime: boolean;
    tierActivatesAt: string | null;
    pendingTier: string | null;
    holdTclawUnlimitedRuntime?: boolean;
  } | null;
  tiers: TierDef[];
};

type ReferralMeResponse = {
  stakeTclawAmount: number;
  stakingUrl: string;
  stakingTier: string | null;
  stakingDiscountPct: number;
  stakingUnlimitedRuntime: boolean;
  holdTclawUnlimitedRuntime?: boolean;
  runtimeUnlimited?: boolean;
  runtimeHoldMinTclaw?: number | null;
  runtimeHoldSplWalletPublicKey?: string | null;
  stakingLinkedWallet: string | null;
  accessUntil: string | null;
  accessSecondsRemaining: number | null;
  referralCode: string | null;
};

function formatTclaw(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: value < 1000 ? 2 : 0 }).format(value);
}

function formatCompactDate(value: string) {
  return new Date(value).toLocaleString();
}

function tierDisplayName(name: string | null) {
  if (!name) return "Inactive";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export default function StakingPage() {
  const { toast } = useToast();
  const { data: wallets, isLoading: walletsLoading } = useQuery<WalletType[] | null>({ queryKey: ["/api/wallets"] });

  const { data: stakingData, isLoading: stakingLoading } = useQuery<StakingEntitlementsResponse>({
    queryKey: ["/api/staking/entitlements"],
    refetchInterval: 30_000,
  });

  const { data: referralMe } = useQuery<ReferralMeResponse>({
    queryKey: ["/api/referral/me"],
  });

  const tiers: TierDef[] = useMemo(() => {
    if (stakingData?.tiers?.length) return stakingData.tiers;
    return [
      { name: "gold", min: 6_000_000, discountPct: 40 },
      { name: "silver", min: 2_000_000, discountPct: 28 },
      { name: "bronze", min: 600_000, discountPct: 18 },
      { name: "standard", min: 200_000, discountPct: 10 },
    ];
  }, [stakingData?.tiers]);

  const tierPreview = useMemo(() => [...tiers].reverse(), [tiers]);

  const staking = stakingData?.staking;
  const stakedAmount = staking?.stakedBalance ?? 0;
  const activeTierName = tierDisplayName(staking?.activeTier ?? null);
  const discountPct = staking?.discountPct ?? 0;
  const unlimitedRuntime = staking?.unlimitedRuntime ?? false;
  const pendingTier = staking?.pendingTier ?? null;
  const tierActivatesAt = staking?.tierActivatesAt ?? null;

  const walletOptions = Array.isArray(wallets) ? wallets : [];
  const [walletSource, setWalletSource] = useState<WalletSource>("external");
  const [selectedWalletId, setSelectedWalletId] = useState<string>("");
  const [externalWalletLabel, setExternalWalletLabel] = useState("Another Stake Wallet");
  const [externalWalletPublicKey, setExternalWalletPublicKey] = useState("");
  const [externalWalletConnected, setExternalWalletConnected] = useState(false);

  const [stakeAmount, setStakeAmount] = useState("10000");
  const [unstakeAmount, setUnstakeAmount] = useState("");
  const [pendingRewards] = useState(0);
  const [cooldownAmount] = useState(0);
  const [cooldownEndsAt] = useState<string | null>(null);
  const [activity, setActivity] = useState<StakeEvent[]>([]);

  useEffect(() => {
    if (!walletOptions.length) return;
    if (selectedWalletId) return;
    setSelectedWalletId(String(walletOptions[0].id));
  }, [walletOptions, selectedWalletId]);

  useEffect(() => {
    if (staking?.linkedWallet) {
      setExternalWalletPublicKey(staking.linkedWallet);
      setExternalWalletConnected(true);
      setWalletSource("external");
    }
  }, [staking?.linkedWallet]);

  const selectedDashboardWallet =
    walletOptions.find((wallet) => String(wallet.id) === selectedWalletId) ?? walletOptions[0] ?? null;

  const connectedWallet: ConnectedWalletView | null = useMemo(() => {
    if (walletSource === "dashboard") {
      if (!selectedDashboardWallet) return null;
      return {
        key: `dashboard-${selectedDashboardWallet.id}`,
        label: selectedDashboardWallet.label || "Primary TraderClaw Wallet",
        publicKey: selectedDashboardWallet.publicKey,
        source: "dashboard",
      };
    }

    if (!externalWalletConnected || !externalWalletPublicKey.trim()) return null;

    return {
      key: "external-wallet",
      label: externalWalletLabel.trim() || "External Stake Wallet",
      publicKey: externalWalletPublicKey.trim(),
      source: "external",
    };
  }, [walletSource, selectedDashboardWallet, externalWalletConnected, externalWalletLabel, externalWalletPublicKey]);

  const runtimeLabel = unlimitedRuntime
    ? "Unlimited runtime"
    : pendingTier
      ? `Pending ${tierDisplayName(pendingTier)} (activates ${tierActivatesAt ? formatCompactDate(tierActivatesAt) : "soon"})`
      : discountPct > 0
        ? `${discountPct}% discount`
        : "No runtime boost";

  const addActivity = (entry: Omit<StakeEvent, "id" | "timestamp">) => {
    setActivity((prev) => [
      {
        id: `${entry.type}-${Date.now()}`,
        timestamp: new Date().toISOString(),
        ...entry,
      },
      ...prev,
    ]);
  };

  const handleConnectExternalWallet = async () => {
    if (!externalWalletPublicKey.trim()) {
      toast({
        title: "Wallet public key required",
        description: "Enter the wallet address you want to use for staking.",
        variant: "destructive",
      });
      return;
    }

    try {
      await apiRequest("POST", "/api/staking/link-wallet", {
        stakingWallet: externalWalletPublicKey.trim(),
      });
      setExternalWalletConnected(true);
      setWalletSource("external");
      addActivity({
        type: "connect",
        label: `Connected ${externalWalletLabel.trim() || "external wallet"}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/staking/entitlements"] });
      queryClient.invalidateQueries({ queryKey: ["/api/referral/me"] });
      toast({ title: "Wallet linked", description: "Staking wallet linked to your account." });
    } catch (err: unknown) {
      toast({
        title: "Link failed",
        description: err instanceof Error ? err.message : "Could not link wallet.",
        variant: "destructive",
      });
    }
  };

  const handleStake = () => {
    const amount = Number(stakeAmount);
    if (!connectedWallet) {
      toast({ title: "No wallet selected", description: "Select or connect a staking wallet first.", variant: "destructive" });
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      toast({ title: "Invalid stake amount", description: `Enter a valid ${TOKEN_TICKER} amount to stake.`, variant: "destructive" });
      return;
    }
    addActivity({
      type: "stake",
      label: `Stake request via ${connectedWallet.label}`,
      amount,
    });
    toast({
      title: "Stake action",
      description: "Submit this transaction in your wallet to complete the stake on-chain.",
    });
  };

  const handleUnstake = () => {
    const amount = Number(unstakeAmount);
    if (!connectedWallet) {
      toast({ title: "No wallet selected", description: "Select or connect a staking wallet first.", variant: "destructive" });
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0 || amount > stakedAmount) {
      toast({ title: "Invalid unstake amount", description: "Enter an amount within the current staked balance.", variant: "destructive" });
      return;
    }
    addActivity({
      type: "unstake",
      label: `Unstake request from ${connectedWallet.label}`,
      amount,
    });
    toast({
      title: "Unstake action",
      description: "Submit this transaction in your wallet to complete the unstake on-chain.",
    });
  };

  const handleClaimRewards = () => {
    if (pendingRewards <= 0) {
      toast({ title: "No rewards available", description: "There are no pending rewards to claim right now.", variant: "destructive" });
      return;
    }
    addActivity({
      type: "claim",
      label: "Rewards claimed",
      amount: pendingRewards,
    });
    toast({ title: "Claim action", description: "Submit this transaction in your wallet to claim rewards on-chain." });
  };

  const handleBuyTclaw = () => {
    toast({
      title: `Buy ${TOKEN_TICKER}`,
      description: "The token buy flow will be connected once the purchase rail is live.",
    });
  };

  const scrollToTierPreview = () => {
    document.getElementById("staking-tier-preview")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (walletsLoading || stakingLoading) {
    return (
      <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-8 px-4 py-4 sm:px-6 sm:py-6" data-testid="page-staking">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold" data-testid="text-staking-title">
          Staking
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Connect a staking wallet, manage {TOKEN_TICKER} stake, and review tier status from one dedicated access surface.
        </p>
      </div>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-4" data-testid="section-staking-summary">
        <Card>
          <CardContent className="space-y-2 p-4">
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
              Connected Wallet
            </div>
            <div className="text-sm text-foreground">{connectedWallet?.label ?? "None selected"}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-2 p-4">
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
              Staked {TOKEN_TICKER}
            </div>
            <div className="text-base text-foreground" style={{ fontFamily: "var(--font-mono)" }}>
              {formatTclaw(stakedAmount)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-2 p-4">
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
              Pending Rewards
            </div>
            <div className="text-base text-foreground" style={{ fontFamily: "var(--font-mono)" }}>
              {formatTclaw(pendingRewards)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-2 p-4">
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
              Active Tier
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-[10px]">{activeTierName}</Badge>
              <span className="text-[11px] text-muted-foreground">{runtimeLabel}</span>
            </div>
          </CardContent>
        </Card>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.1fr_1.2fr]">
        <Card data-testid="card-staking-wallet-source">
          <CardHeader className="space-y-3">
            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                Wallet
              </div>
              <CardTitle className="text-base">Connect wallet</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setWalletSource("dashboard")}
                className={`border px-4 py-4 text-left transition-colors ${
                  walletSource === "dashboard"
                    ? "border-primary/35 bg-primary/8 text-foreground"
                    : "border-border/70 bg-muted/10 text-muted-foreground hover:border-primary/20 hover:bg-primary/5"
                }`}
                data-testid="button-wallet-source-dashboard"
              >
                <div className="mb-1 text-[11px] uppercase tracking-[0.14em]" style={{ fontFamily: "var(--font-mono)" }}>
                  TraderClaw
                </div>
                <div className="text-sm text-foreground">Use a dashboard wallet</div>
                <div className="mt-2 text-[11px] text-muted-foreground">
                  Select the same wallet already used inside the dashboard.
                </div>
              </button>

              <button
                type="button"
                onClick={() => setWalletSource("external")}
                className={`border px-4 py-4 text-left transition-colors ${
                  walletSource === "external"
                    ? "border-primary/35 bg-primary/8 text-foreground"
                    : "border-border/70 bg-muted/10 text-muted-foreground hover:border-primary/20 hover:bg-primary/5"
                }`}
                data-testid="button-wallet-source-external"
              >
                <div className="mb-1 text-[11px] uppercase tracking-[0.14em]" style={{ fontFamily: "var(--font-mono)" }}>
                  External
                </div>
                <div className="text-sm text-foreground">Connect another wallet</div>
                <div className="mt-2 text-[11px] text-muted-foreground">
                  This path stages the external staking flow with a separate wallet address.
                </div>
              </button>
            </div>

            {walletSource === "dashboard" ? (
              Array.isArray(wallets) && wallets.length > 0 ? (
                <div className="space-y-3">
                  <div className="space-y-2">
                    <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                      Select Wallet
                    </div>
                    <Select value={selectedWalletId || String(walletOptions[0]?.id || "")} onValueChange={setSelectedWalletId}>
                      <SelectTrigger className="text-sm" data-testid="select-staking-dashboard-wallet">
                        <SelectValue placeholder="Select wallet" />
                      </SelectTrigger>
                      <SelectContent>
                        {walletOptions.map((wallet) => (
                          <SelectItem key={wallet.id} value={String(wallet.id)}>
                            {wallet.label || `Wallet ${wallet.id}`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {selectedDashboardWallet ? (
                    <div className="border border-border/70 bg-muted/10 px-3 py-3">
                      <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                        Selected Wallet
                      </div>
                      <div className="text-sm text-foreground">{selectedDashboardWallet.label}</div>
                      <div className="mt-1 break-all text-[11px] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                        {selectedDashboardWallet.publicKey}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <EmptyState
                  icon={Wallet}
                  title="No dashboard wallet found"
                  description="Create a wallet first or use the external wallet flow below."
                  compact
                  framed={false}
                />
              )
            ) : (
              <div className="space-y-3">
                <div className="space-y-2">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                    External Wallet Label
                  </div>
                  <Input
                    value={externalWalletLabel}
                    onChange={(e) => setExternalWalletLabel(e.target.value)}
                    placeholder="Another Stake Wallet"
                    data-testid="input-staking-external-wallet-label"
                  />
                </div>
                <div className="space-y-2">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                    Wallet Address
                  </div>
                  <Input
                    value={externalWalletPublicKey}
                    onChange={(e) => setExternalWalletPublicKey(e.target.value)}
                    placeholder="Paste wallet public key"
                    className="font-mono text-xs"
                    data-testid="input-staking-external-wallet-address"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleConnectExternalWallet}
                    data-testid="button-staking-connect-wallet"
                  >
                    <Link2 className="mr-1.5 h-3.5 w-3.5" />
                    Connect another wallet
                  </Button>
                  {externalWalletConnected ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setExternalWalletConnected(false);
                        toast({ title: "Wallet disconnected" });
                      }}
                      data-testid="button-staking-disconnect-wallet"
                    >
                      Disconnect
                    </Button>
                  ) : null}
                </div>
              </div>
            )}

            {connectedWallet ? (
              <div className="border border-border/70 bg-muted/10 px-3 py-3">
                <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                  Active Wallet
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-foreground">{connectedWallet.label}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {connectedWallet.source === "dashboard" ? "Dashboard wallet" : "External wallet"}
                  </Badge>
                </div>
                <div className="mt-1 break-all text-[11px] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                  {connectedWallet.publicKey}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card data-testid="card-staking-actions">
          <CardHeader className="space-y-3">
            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                {TOKEN_TICKER}
              </div>
              <CardTitle className="text-base">Stake, unstake, rewards</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <Tabs defaultValue="stake" className="w-fit">
              <TabsList>
                <TabsTrigger value="stake">Stake</TabsTrigger>
                <TabsTrigger value="unstake">Unstake</TabsTrigger>
                <TabsTrigger value="rewards">Rewards</TabsTrigger>
              </TabsList>

              <TabsContent value="stake" className="space-y-4">
                <div className="space-y-2">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                    Stake Amount
                  </div>
                  <Input
                    value={stakeAmount}
                    onChange={(e) => setStakeAmount(e.target.value)}
                    placeholder="10000"
                    className="font-mono"
                    data-testid="input-staking-stake-amount"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  {["5000", "10000", "25000", "50000"].map((preset) => (
                    <Button
                      key={preset}
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setStakeAmount(preset)}
                      data-testid={`button-staking-preset-${preset}`}
                    >
                      {preset}
                    </Button>
                  ))}
                </div>
                <div className="border border-border/70 bg-muted/10 px-3 py-3">
                  <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                    Runtime Boost
                  </div>
                  <div className="text-sm text-foreground">{runtimeLabel}</div>
                </div>
                <Button
                  type="button"
                  onClick={handleStake}
                  disabled={!connectedWallet}
                  data-testid="button-staking-stake"
                >
                  <Lock className="mr-1.5 h-3.5 w-3.5" />
                  Stake {TOKEN_TICKER}
                </Button>
              </TabsContent>

              <TabsContent value="unstake" className="space-y-4">
                <div className="space-y-2">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                    Unstake Amount
                  </div>
                  <Input
                    value={unstakeAmount}
                    onChange={(e) => setUnstakeAmount(e.target.value)}
                    placeholder="2500"
                    className="font-mono"
                    data-testid="input-staking-unstake-amount"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setUnstakeAmount(String(Math.max(0, Math.round(stakedAmount / 2))))}
                    data-testid="button-staking-half"
                  >
                    50%
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setUnstakeAmount(String(Math.round(stakedAmount)))}
                    data-testid="button-staking-max"
                  >
                    Max
                  </Button>
                </div>
                <div className="border border-border/70 bg-muted/10 px-3 py-3">
                  <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                    Cooldown
                  </div>
                  <div className="text-sm text-foreground">
                    {cooldownAmount > 0 ? `${formatTclaw(cooldownAmount)} ${TOKEN_TICKER} pending release` : "No unstake cooldown active"}
                  </div>
                  {cooldownEndsAt ? (
                    <div className="mt-1 text-[11px] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                      Unlocks {formatCompactDate(cooldownEndsAt)}
                    </div>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleUnstake}
                  disabled={!connectedWallet}
                  data-testid="button-staking-unstake"
                >
                  <Unlock className="mr-1.5 h-3.5 w-3.5" />
                  Unstake {TOKEN_TICKER}
                </Button>
              </TabsContent>

              <TabsContent value="rewards" className="space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="border border-border/70 bg-muted/10 px-3 py-3">
                    <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                      Pending Rewards
                    </div>
                    <div className="text-base text-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                      {formatTclaw(pendingRewards)} {TOKEN_TICKER}
                    </div>
                  </div>
                  <div className="border border-border/70 bg-muted/10 px-3 py-3">
                    <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                      Current Tier
                    </div>
                    <div className="text-base text-foreground">{activeTierName}</div>
                  </div>
                </div>
                <div className="border border-border/70 bg-muted/10 px-3 py-3">
                  <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                    Reward Path
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Rewards and claim path will be connected once the staking contracts are live on-chain.
                  </div>
                </div>
                <Button
                  type="button"
                  onClick={handleClaimRewards}
                  disabled={!connectedWallet || pendingRewards <= 0}
                  data-testid="button-staking-claim"
                >
                  <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                  Claim rewards
                </Button>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.25fr_0.75fr]">
        <Card id="staking-tier-preview" data-testid="card-staking-tier-preview">
          <CardHeader className="space-y-3">
            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                Tiers
              </div>
              <CardTitle className="text-base">Staking tiers</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
              Stake {TOKEN_TICKER} to unlock discount tiers and unlimited agent runtime at Standard and above.
            </p>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
              {tierPreview.map((tier) => {
                const isActive = staking?.activeTier === tier.name;

                return (
                  <div
                    key={tier.name}
                    className={`flex h-full flex-col gap-4 border px-4 py-4 transition-colors ${
                      isActive
                        ? "border-primary/35 bg-primary/8"
                        : "border-border/70 bg-muted/10"
                    }`}
                    data-testid={`card-staking-tier-${tier.name.toLowerCase()}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div
                          className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
                          style={{ fontFamily: "var(--font-mono)" }}
                        >
                          {formatTclaw(tier.min)} {TOKEN_TICKER}
                        </div>
                        <div className="text-base text-foreground">{tierDisplayName(tier.name)}</div>
                      </div>
                      <Badge variant="outline" className="text-[10px]">
                        {isActive ? "Active" : `${tier.discountPct}%`}
                      </Badge>
                    </div>

                    <div className="space-y-2">
                      <div className="text-sm text-foreground">{tier.discountPct}% discount</div>
                      <div className="text-sm text-foreground">
                        {tier.name === "standard" || tier.name === "bronze" || tier.name === "silver" || tier.name === "gold"
                          ? "Unlimited runtime"
                          : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-buy-tclaw">
          <CardHeader className="space-y-3">
            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                Token
              </div>
              <CardTitle className="text-base">Buy {TOKEN_TICKER}</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="inline-flex h-10 w-10 items-center justify-center text-primary">
                <ShoppingCart className="h-6 w-6" />
              </span>
              <div className="text-sm leading-6 text-muted-foreground">
                Build toward higher staking tiers, stronger discounts, and unlimited agent runtime from one token position.
              </div>
            </div>

            <div className="space-y-2 border-t border-border/70 pt-4">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">Tier unlocks</span>
                <span className="text-foreground">Standard / Bronze / Silver / Gold</span>
              </div>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">Max discount</span>
                <span className="text-foreground">Up to 40%</span>
              </div>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">Status</span>
                <span className="text-foreground">Buy rail staged</span>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Button
                type="button"
                onClick={handleBuyTclaw}
                data-testid="button-buy-tclaw"
              >
                <ShoppingCart className="mr-1.5 h-3.5 w-3.5" />
                Buy {TOKEN_TICKER}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={scrollToTierPreview}
                data-testid="button-view-staking-tiers"
              >
                View tiers
                <ArrowUpRight className="ml-1.5 h-3.5 w-3.5" />
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <Card data-testid="card-staking-position">
          <CardHeader className="space-y-3">
            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                Position
              </div>
              <CardTitle className="text-base">Stake overview</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between gap-3 border border-border/70 bg-muted/10 px-3 py-3">
              <span className="text-sm text-muted-foreground">Staked amount</span>
              <span className="font-mono text-sm text-foreground">{formatTclaw(stakedAmount)} {TOKEN_TICKER}</span>
            </div>
            <div className="flex items-center justify-between gap-3 border border-border/70 bg-muted/10 px-3 py-3">
              <span className="text-sm text-muted-foreground">Cooldown</span>
              <span className="font-mono text-sm text-foreground">{formatTclaw(cooldownAmount)} {TOKEN_TICKER}</span>
            </div>
            <div className="flex items-center justify-between gap-3 border border-border/70 bg-muted/10 px-3 py-3">
              <span className="text-sm text-muted-foreground">Rewards pending</span>
              <span className="font-mono text-sm text-foreground">{formatTclaw(pendingRewards)} {TOKEN_TICKER}</span>
            </div>
            <div className="flex items-center justify-between gap-3 border border-border/70 bg-muted/10 px-3 py-3">
              <span className="text-sm text-muted-foreground">Runtime tier</span>
              <span className="text-sm text-foreground">{activeTierName}</span>
            </div>
            {discountPct > 0 && (
              <div className="flex items-center justify-between gap-3 border border-border/70 bg-muted/10 px-3 py-3">
                <span className="text-sm text-muted-foreground">Discount</span>
                <span className="text-sm text-foreground">{discountPct}%</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-staking-activity">
          <CardHeader className="space-y-3">
            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                Activity
              </div>
              <CardTitle className="text-base">Recent actions</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {activity.length ? (
              activity.slice(0, 6).map((event) => (
                <div key={event.id} className="border border-border/70 bg-muted/10 px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                        <span className="text-sm text-foreground">{event.label}</span>
                      </div>
                      <div className="text-[11px] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                        {formatCompactDate(event.timestamp)}
                      </div>
                    </div>
                    {typeof event.amount === "number" ? (
                      <Badge variant="outline" className="text-[10px]">
                        {formatTclaw(event.amount)} {TOKEN_TICKER}
                      </Badge>
                    ) : null}
                  </div>
                </div>
              ))
            ) : (
              <EmptyState
                icon={Clock}
                title="No staking activity"
                description="Stake, unstake, and reward actions will appear here."
                compact
                framed={false}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
