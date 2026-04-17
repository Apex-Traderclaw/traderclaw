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
import { ArrowUpRight, Certificate, CheckCircle2, Clock, Link2, Lock, ShoppingCart, Sparkles, Unlock, Wallet } from "@/components/ui/icons";
import type { Wallet as WalletType } from "@shared/schema";

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

const STAKE_TIERS = [
  {
    min: 50000,
    name: "Operator",
    runtimeBoost: "+72h runtime",
    rewardsPath: "1.4x rewards path",
    summary: "Built for higher-conviction operators who want the strongest runtime and rewards profile.",
  },
  {
    min: 25000,
    name: "Pro",
    runtimeBoost: "+36h runtime",
    rewardsPath: "1.15x rewards path",
    summary: "Balanced tier for desks that want more runtime headroom without moving into the top band.",
  },
  {
    min: 10000,
    name: "Base",
    runtimeBoost: "+12h runtime",
    rewardsPath: "0.9x rewards path",
    summary: "Entry staking lane for getting into TCLAW staking with a lighter commitment level.",
  },
];

const STAKE_TIER_PREVIEW = [...STAKE_TIERS].reverse();

function formatTclaw(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: value < 1000 ? 2 : 0 }).format(value);
}

function formatCompactDate(value: string) {
  return new Date(value).toLocaleString();
}

function resolveTier(stakedAmount: number) {
  return STAKE_TIERS.find((tier) => stakedAmount >= tier.min) ?? null;
}

export default function StakingPage() {
  const { toast } = useToast();
  const { data: wallets, isLoading: walletsLoading } = useQuery<WalletType[] | null>({ queryKey: ["/api/wallets"] });

  const walletOptions = Array.isArray(wallets) ? wallets : [];
  const [walletSource, setWalletSource] = useState<WalletSource>("external");
  const [selectedWalletId, setSelectedWalletId] = useState<string>("");
  const [externalWalletLabel, setExternalWalletLabel] = useState("Another Stake Wallet");
  const [externalWalletPublicKey, setExternalWalletPublicKey] = useState("");
  const [externalWalletConnected, setExternalWalletConnected] = useState(false);

  const [stakeAmount, setStakeAmount] = useState("10000");
  const [unstakeAmount, setUnstakeAmount] = useState("");
  const [stakedAmount, setStakedAmount] = useState(18500);
  const [pendingRewards, setPendingRewards] = useState(247.25);
  const [cooldownAmount, setCooldownAmount] = useState(0);
  const [cooldownEndsAt, setCooldownEndsAt] = useState<string | null>(null);
  const [activity, setActivity] = useState<StakeEvent[]>([
    {
      id: "seed-runtime-bonus",
      type: "stake",
      label: "Runtime bonus tier activated",
      amount: 18500,
      timestamp: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
    },
    {
      id: "seed-claim",
      type: "claim",
      label: "Last rewards claim",
      amount: 84,
      timestamp: new Date(Date.now() - 1000 * 60 * 60 * 18).toISOString(),
    },
  ]);

  useEffect(() => {
    if (!walletOptions.length) return;
    if (selectedWalletId) return;
    setSelectedWalletId(String(walletOptions[0].id));
  }, [walletOptions, selectedWalletId]);

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

  const activeTier = resolveTier(stakedAmount);
  const activeTierName = activeTier?.name ?? "Inactive";
  const runtimeBoost = activeTier?.runtimeBoost ?? "No runtime boost";

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

  const handleConnectExternalWallet = () => {
    if (!externalWalletPublicKey.trim()) {
      toast({
        title: "Wallet public key required",
        description: "Enter the wallet address you want to use for staking.",
        variant: "destructive",
      });
      return;
    }

    setExternalWalletConnected(true);
    setWalletSource("external");
    addActivity({
      type: "connect",
      label: `Connected ${externalWalletLabel.trim() || "external wallet"}`,
    });
    toast({ title: "Wallet connected", description: "External staking wallet is now selected." });
  };

  const handleStake = () => {
    const amount = Number(stakeAmount);
    if (!connectedWallet) {
      toast({ title: "No wallet selected", description: "Select or connect a staking wallet first.", variant: "destructive" });
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      toast({ title: "Invalid stake amount", description: "Enter a valid TCLAW amount to stake.", variant: "destructive" });
      return;
    }

    setStakedAmount((prev) => prev + amount);
    setPendingRewards((prev) => prev + amount * 0.002);
    setStakeAmount("");
    addActivity({
      type: "stake",
      label: `Staked via ${connectedWallet.label}`,
      amount,
    });
    toast({ title: "Stake staged", description: "Frontend preview updated the staking position locally." });
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

    const cooldownEnd = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString();
    setStakedAmount((prev) => Math.max(0, prev - amount));
    setCooldownAmount((prev) => prev + amount);
    setCooldownEndsAt(cooldownEnd);
    setUnstakeAmount("");
    addActivity({
      type: "unstake",
      label: `Unstake request from ${connectedWallet.label}`,
      amount,
    });
    toast({ title: "Unstake request staged", description: "Frontend preview moved the amount into cooldown locally." });
  };

  const handleClaimRewards = () => {
    if (pendingRewards <= 0) {
      toast({ title: "No rewards available", description: "There are no pending rewards to claim right now.", variant: "destructive" });
      return;
    }
    const claimed = pendingRewards;
    setPendingRewards(0);
    addActivity({
      type: "claim",
      label: "Rewards claimed",
      amount: claimed,
    });
    toast({ title: "Rewards staged", description: "Frontend preview marked rewards as claimed locally." });
  };

  const handleBuyTclaw = () => {
    toast({
      title: "TCLAW buy flow staged",
      description: "This frontend preview is ready for the token-buy rail once the final purchase path is connected.",
    });
  };

  const scrollToTierPreview = () => {
    document.getElementById("staking-tier-preview")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (walletsLoading) {
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
          Connect a staking wallet, manage TCLAW stake, and review unstake and rewards status from one dedicated access surface.
          <br />
          This is a frontend staging flow for the staking experience until the final staking backend and wallet-connect path are wired.
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
              Staked TCLAW
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
              <span className="text-[11px] text-muted-foreground">{runtimeBoost}</span>
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
                  This path is preselected and stages the external staking flow with a separate wallet address.
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
                TCLAW
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
                  <div className="text-sm text-foreground">{runtimeBoost}</div>
                </div>
                <Button
                  type="button"
                  onClick={handleStake}
                  disabled={!connectedWallet}
                  data-testid="button-staking-stake"
                >
                  <Lock className="mr-1.5 h-3.5 w-3.5" />
                  Stake TCLAW
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
                    {cooldownAmount > 0 ? `${formatTclaw(cooldownAmount)} TCLAW pending release` : "No unstake cooldown active"}
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
                  Unstake TCLAW
                </Button>
              </TabsContent>

              <TabsContent value="rewards" className="space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="border border-border/70 bg-muted/10 px-3 py-3">
                    <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                      Pending Rewards
                    </div>
                    <div className="text-base text-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                      {formatTclaw(pendingRewards)} TCLAW
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
                    Rewards and staking updates are staged locally in this frontend flow until the final staking contracts and claim path are connected.
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
                Preview
              </div>
              <CardTitle className="text-base">Tier preview</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
              Preview the staged staking ladder below. These tier surfaces are placeholders for the final SaaS-style staking and access plans.
            </p>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              {STAKE_TIER_PREVIEW.map((tier) => {
                const isActive = activeTierName === tier.name;

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
                          {formatTclaw(tier.min)} TCLAW
                        </div>
                        <div className="text-base text-foreground">{tier.name}</div>
                      </div>
                      <Badge variant="outline" className="text-[10px]">
                        {isActive ? "Active" : "Preview"}
                      </Badge>
                    </div>

                    <div className="space-y-2">
                      <div className="text-sm text-foreground">{tier.runtimeBoost}</div>
                      <div className="text-sm text-foreground">{tier.rewardsPath}</div>
                    </div>

                    <p className="mt-auto text-sm leading-6 text-muted-foreground">
                      {tier.summary}
                    </p>
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
              <CardTitle className="text-base">Buy TCLAW</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="inline-flex h-10 w-10 items-center justify-center text-primary">
                <ShoppingCart className="h-6 w-6" />
              </span>
              <div className="text-sm leading-6 text-muted-foreground">
                Build toward higher staking tiers, stronger runtime boosts, and the staged rewards path from one token position.
              </div>
            </div>

            <div className="space-y-2 border-t border-border/70 pt-4">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">Tier unlocks</span>
                <span className="text-foreground">Base / Pro / Operator</span>
              </div>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">Runtime upside</span>
                <span className="text-foreground">Up to +72h</span>
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
                Buy TCLAW
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
              <span className="font-mono text-sm text-foreground">{formatTclaw(stakedAmount)} TCLAW</span>
            </div>
            <div className="flex items-center justify-between gap-3 border border-border/70 bg-muted/10 px-3 py-3">
              <span className="text-sm text-muted-foreground">Cooldown</span>
              <span className="font-mono text-sm text-foreground">{formatTclaw(cooldownAmount)} TCLAW</span>
            </div>
            <div className="flex items-center justify-between gap-3 border border-border/70 bg-muted/10 px-3 py-3">
              <span className="text-sm text-muted-foreground">Rewards pending</span>
              <span className="font-mono text-sm text-foreground">{formatTclaw(pendingRewards)} TCLAW</span>
            </div>
            <div className="flex items-center justify-between gap-3 border border-border/70 bg-muted/10 px-3 py-3">
              <span className="text-sm text-muted-foreground">Runtime tier</span>
              <span className="text-sm text-foreground">{activeTierName}</span>
            </div>
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
                        {formatTclaw(event.amount)} TCLAW
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
