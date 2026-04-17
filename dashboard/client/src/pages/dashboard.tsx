import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { motion, useReducedMotion } from "framer-motion";
import { apiRequest, isAdminSession, queryClient } from "@/lib/queryClient";
import {
  Wallet, TrendingUp, TrendingDown, Activity,
  Zap, Rocket, Flame, ArrowUpRight, Crown,
  Search, AlertTriangle, CheckCircle, XCircle, BookOpen, RefreshCw, Copy, ExternalLink,
  ChartLineUp, ChartPieSlice, Clock, Gift, Graph, Pause, Play, Power, Rows, ShieldCheckered, SlidersHorizontal, Waveform,
} from "@/components/ui/icons";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { SolAmount, SolanaMark } from "@/components/ui/solana-mark";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { Wallet as WalletType, Position, KillSwitch, StrategyState } from "@shared/schema";

const TITLE_FONT = { fontFamily: "var(--font-display)" };
const BODY_FONT = { fontFamily: "var(--font-sans)" };
const MONO_FONT = { fontFamily: "var(--font-mono)" };
const DASHBOARD_EASE = [0.22, 1, 0.36, 1] as const;

type AdminKpisResponse = {
  installs: number;
  activeClaws: number;
  tradesExecuted: number;
  walletsFunded: number;
  volumeGeneratedUsd: number;
  milestoneProgress?: { progressPct?: number };
  bitqueryUsage?: { requestCount?: number };
  websocketsActive?: { connected?: number; authenticated?: number };
};

type ReferralPreviewResponse = {
  referralCode: string | null;
  referralTier: string;
  referralPercentage: number;
  referralProgramEnabled: boolean;
  waitlistSyncedAt: string | null;
};

const RUNTIME_PREVIEW_FALLBACK_SECONDS = (2 * 24 * 60 * 60) + (9 * 60 * 60) + (28 * 60) + 14;
const RUNTIME_PREVIEW_UNITS = [
  { label: "mo", seconds: 60 * 60 * 24 * 30 },
  { label: "w", seconds: 60 * 60 * 24 * 7 },
  { label: "d", seconds: 60 * 60 * 24 },
  { label: "h", seconds: 60 * 60 },
  { label: "m", seconds: 60 },
];

function formatSol(val: number) {
  return val.toFixed(4);
}

function formatUsd(val: number) {
  return val.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

function formatRuntimePreviewCountdown(totalSeconds: number | null) {
  if (totalSeconds === null) return "INFINITE";

  let remainingSeconds = Math.max(0, Math.floor(totalSeconds));
  const parts: string[] = [];

  for (const unit of RUNTIME_PREVIEW_UNITS) {
    const value = Math.floor(remainingSeconds / unit.seconds);
    if (value > 0) {
      parts.push(`${value}${unit.label}`);
      remainingSeconds -= value * unit.seconds;
    }
  }

  parts.push(`${remainingSeconds}s`);
  return parts.join(" ");
}

function DashboardMotion({
  children,
  className,
  delay = 0,
  distance = 14,
  hover = false,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  distance?: number;
  hover?: boolean;
}) {
  const reducedMotion = useReducedMotion();

  return (
    <motion.div
      className={className}
      initial={reducedMotion ? false : { opacity: 0, y: distance, scale: 0.988 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={
        reducedMotion
          ? { duration: 0 }
          : { duration: 0.46, delay, ease: DASHBOARD_EASE }
      }
      whileHover={
        reducedMotion || !hover
          ? undefined
          : {
              y: -2,
              transition: {
                duration: 0.18,
                ease: DASHBOARD_EASE,
              },
            }
      }
    >
      {children}
    </motion.div>
  );
}

function shortenAddress(value?: string | null) {
  if (!value) return "UNKNOWN";
  if (value.length <= 10) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function toDexscreenerUrl(tokenAddress?: string | null) {
  if (!tokenAddress) return null;
  return `https://dexscreener.com/solana/${tokenAddress}`;
}

function PnlText({ value, showUnit = false }: { value: number; showUnit?: boolean }) {
  const color = value > 0 ? "hsl(var(--profit))" : value < 0 ? "hsl(var(--loss))" : "hsl(var(--muted-foreground))";
  const prefix = value > 0 ? "+" : "";
  const formattedValue = `${prefix}${formatSol(value)}`;
  if (showUnit) {
    return (
      <SolAmount
        value={formattedValue}
        className="font-mono font-bold"
        valueStyle={{ color }}
        markClassName="h-[0.8em] w-[0.8em]"
      />
    );
  }
  return (
    <span style={{ fontFamily: "var(--font-mono)", color, fontWeight: 700 }}>
      {formattedValue}
    </span>
  );
}

/** Thin orange top-border accent for stat cards */
function StatCard({ children, className = "", testId = "" }: { children: React.ReactNode; className?: string; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className={`group/card card-glow h-full bg-card overflow-hidden ${className}`}
    >
      {children}
    </div>
  );
}

function DashboardIconBadge({
  icon: Icon,
  tone = "neutral",
  className = "",
}: {
  icon: any;
  tone?: "neutral" | "profit" | "loss";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center transition-[transform,color] duration-200 will-change-transform group-hover/card:-translate-y-px group-hover/card:scale-[1.03]",
        tone === "profit" && "text-profit",
        tone === "loss" && "text-loss",
        tone === "neutral" && "text-foreground group-hover/card:text-primary",
        className,
      )}
    >
      <Icon className="h-5 w-5" />
    </span>
  );
}

function ThesisPackageView({ data }: { data: any }) {
  if (!data) return null;
  const { meta, marketData, walletContext, strategyContext, memoryContext, riskPreScreen } = data;
  const snapshot = marketData?.snapshot || {};
  const liquidity = marketData?.liquidity || {};
  const holders = marketData?.holders || {};
  const flows = marketData?.flows || {};
  const riskFlags = Array.isArray(marketData?.risk?.flags) ? marketData.risk.flags : [];
  const reasons = Array.isArray(riskPreScreen?.reasons) ? riskPreScreen.reasons : [];
  const priorTokenEntries = Array.isArray(memoryContext?.priorTokenEntries) ? memoryContext.priorTokenEntries : [];
  const journalSummary = memoryContext?.journalSummary || {};
  const journalWinRate = Number(journalSummary?.winRate || 0);
  const journalEntries = Number(journalSummary?.totalEntries || 0);
  const journalPeriod = String(journalSummary?.period || "7d");
  const symbolLabel = meta?.symbol || snapshot?.symbol || shortenAddress(meta?.tokenAddress);
  const tokenLabel = String(meta?.tokenAddress || snapshot?.tokenAddress || "unknown");
  const balanceSol = Number(walletContext?.balanceSol || 0);
  const openPositions = Number(walletContext?.openPositionCount || 0);

  return (
    <div className="space-y-3 mt-3" data-testid="thesis-package">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold" style={BODY_FONT}>{symbolLabel}</span>
        <span className="text-xs text-muted-foreground" style={MONO_FONT}>{shortenAddress(tokenLabel)}</span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        {[
          { label: "Price", value: `$${Number(snapshot?.priceUsd || 0).toFixed(6)}` },
          { label: "24h Volume", value: `$${(Number(snapshot?.volumeUsd24h || 0) / 1000).toFixed(0)}k` },
          { label: "Liquidity", value: `$${(Number(liquidity?.totalLiquidityUsd || 0) / 1000).toFixed(0)}k` },
          { label: "Top 10 Hold.", value: `${Number(holders?.top10ConcentrationPct || 0).toFixed(1)}%` },
          { label: "Buy Pressure", value: `${(Number(flows?.buyPressureRatio || 0) * 100).toFixed(0)}%` },
          { label: "Traders", value: `${Number(flows?.uniqueTraders || 0)}` },
        ].map(({ label, value }) => (
          <div key={label} className="space-y-0.5">
            <span className="text-muted-foreground text-xs tracking-[0.12em] uppercase" style={MONO_FONT}>{label}</span>
            <div style={MONO_FONT}>{value}</div>
          </div>
        ))}
      </div>

      <div className="border-t border-border/60 pt-2">
        <div className="flex items-center gap-1 mb-1">
          {riskPreScreen?.approved
            ? <CheckCircle className="w-3.5 h-3.5 text-foreground" />
            : <XCircle className="w-3.5 h-3.5 text-foreground" />}
          <span className="text-sm font-medium" style={BODY_FONT}>
            Risk Pre-Screen: {riskPreScreen?.approved ? "Would Pass" : "Would Deny"}
          </span>
        </div>
        {Number(riskPreScreen?.cappedSizeSol || 0) > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" style={MONO_FONT}>
            <span>Capped size:</span>
            <SolAmount
              value={Number(riskPreScreen?.cappedSizeSol || 0).toFixed(4)}
              valueClassName="text-muted-foreground"
              markClassName="h-3 w-3"
            />
          </div>
        )}
        {reasons.length > 0 && (
          <div className="space-y-0.5 mt-1">
            {reasons.map((r: { severity: string; message: string }) => (
              <div key={r.message} className="flex items-center gap-1 text-xs">
                <AlertTriangle className="w-3 h-3 text-foreground" />
                <span className="text-muted-foreground">{r.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {riskFlags.length > 0 && (
        <div className="border-t border-border/60 pt-2">
          <span className="text-xs text-muted-foreground uppercase tracking-[0.12em]" style={MONO_FONT}>Risk Flags:</span>
          <div className="flex flex-wrap gap-1 mt-1">
            {riskFlags.map((f: string) => (
              <Badge key={f} variant="destructive" className="text-[10px]">{f}</Badge>
            ))}
          </div>
        </div>
      )}

      {priorTokenEntries.length > 0 && (
        <div className="border-t border-border/60 pt-2">
          <div className="flex items-center gap-1 mb-1">
            <BookOpen className="w-3.5 h-3.5 text-foreground" />
            <span className="text-xs text-muted-foreground" style={BODY_FONT}>
              {priorTokenEntries.length} prior trade(s) on this token
            </span>
          </div>
        </div>
      )}

      <div className="border-t border-border/60 pt-2 text-xs text-muted-foreground" style={MONO_FONT}>
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span>Strategy: {strategyContext?.strategyVersion || "v1.0.0"} | Balance:</span>
          <SolAmount
            value={balanceSol.toFixed(2)}
            valueClassName="text-muted-foreground"
            markClassName="h-3 w-3"
          />
          <span>| {openPositions} open</span>
        </div>
        <div>Journal: {journalWinRate.toFixed(0)}% win rate ({journalEntries} entries, {journalPeriod})</div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { toast } = useToast();
  const [thesisToken, setThesisToken] = useState("");
  const [runtimePreviewPaused, setRuntimePreviewPaused] = useState(false);
  const [runtimePreviewNow, setRuntimePreviewNow] = useState(() => Date.now());
  const [runtimePreviewStartedAt] = useState(() => Date.now());
  const isAdmin = isAdminSession();

  const { data: wallets, isLoading: walletsLoading } = useQuery<WalletType[]>({
    queryKey: ["/api/wallets"],
  });
  const wallet = wallets?.[0];

  const { data: capital, isLoading: capitalLoading, isFetching: capitalRefreshing, refetch: refetchCapital } = useQuery<any>({
    queryKey: ["/api/capital/status", wallet?.id ? `?walletId=${wallet.id}` : ""],
    enabled: !!wallet?.id,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: 15_000,
  });

  const { data: positions } = useQuery<Position[]>({
    queryKey: ["/api/wallet/positions", wallet?.id ? `?walletId=${wallet.id}&status=open` : ""],
    enabled: !!wallet?.id,
    queryFn: async ({ queryKey }) => {
      const [, search] = queryKey as [string, string];
      const res = await apiRequest("GET", `/api/wallet/positions${search || ""}`);
      const payload = await res.json();
      if (Array.isArray(payload)) return payload;
      if (Array.isArray(payload?.positions)) return payload.positions;
      return [];
    },
  });

  /** Sum row uPnL when we have positions (includes live WebSocket merges); else capital aggregate. */
  const totalUnrealized = useMemo(() => {
    if (positions && positions.length > 0) {
      return positions.reduce((s, p) => s + Number(p.unrealizedPnl || 0), 0);
    }
    return Number(capital?.totalUnrealizedPnl ?? 0);
  }, [positions, capital?.totalUnrealizedPnl]);

  const { data: killSwitch } = useQuery<KillSwitch>({
    queryKey: ["/api/killswitch/status", wallet?.id ? `?walletId=${wallet.id}` : ""],
    enabled: !!wallet?.id,
  });
  const killSwitchQueryKey = ["/api/killswitch/status", wallet?.id ? `?walletId=${wallet.id}` : ""];

  const { data: entitlementData } = useQuery<any>({
    queryKey: ["/api/entitlements/current", wallet?.id ? `?walletId=${wallet.id}` : ""],
    enabled: !!wallet?.id,
  });

  const { data: referralPreview } = useQuery<ReferralPreviewResponse | null>({
    queryKey: ["/api/referral/me"],
  });

  const { data: systemStatus } = useQuery<any>({
    queryKey: ["/api/system/status"],
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
  });

  const { data: strategyState } = useQuery<StrategyState>({
    queryKey: ["/api/strategy/state", wallet?.id ? `?walletId=${wallet.id}` : ""],
    enabled: !!wallet?.id,
  });
  const {
    data: adminKpis,
    isFetching: adminKpisRefreshing,
    refetch: refetchAdminKpis,
  } = useQuery<AdminKpisResponse>({
    queryKey: ["/api/admin/kpis"],
    enabled: isAdmin,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const killSwitchMutation = useMutation({
    mutationFn: async (params: { enabled: boolean; mode: string }) => {
      const res = await apiRequest("POST", "/api/killswitch", {
        walletId: wallet?.id,
        ...params,
      });
      return res.json();
    },
    onMutate: async (nextState) => {
      await queryClient.cancelQueries({ queryKey: killSwitchQueryKey });
      const previous = queryClient.getQueryData<any>(killSwitchQueryKey);
      queryClient.setQueryData<any>(killSwitchQueryKey, (current: any) => ({
        ...(current || { walletId: wallet?.id || "", updatedAt: new Date().toISOString() }),
        enabled: nextState.enabled,
        mode: nextState.mode,
        updatedAt: new Date().toISOString(),
      }));
      return { previous };
    },
    onError: (_err, _nextState, context) => {
      if (context?.previous) {
        queryClient.setQueryData(killSwitchQueryKey, context.previous);
      }
      toast({ title: "Kill switch update failed", variant: "destructive" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: killSwitchQueryKey });
      toast({ title: "Kill switch updated" });
    },
  });

  const scanMutation = useMutation({
    mutationFn: async (endpoint: string) => {
      const res = await apiRequest("POST", endpoint);
      const payload = await res.json();
      return payload;
    },
  });
  const scanData = scanMutation.data;
  const scanSummary = useMemo(() => {
    if (!scanData) return null;
    if (Array.isArray(scanData.launches)) {
      return {
        label: "New Launches",
        count: scanData.launches.length,
        rows: scanData.launches.slice(0, 3).map((item: any) => {
          const when = item?.timestamp ? new Date(item.timestamp).toLocaleTimeString() : "--:--";
          return {
            label: `${shortenAddress(item?.tokenAddress)} · ${String(item?.program || "unknown").toUpperCase()} · ${when}`,
            tokenAddress: String(item?.tokenAddress || ""),
          };
        }),
        lines: [] as string[],
      };
    }
    if (Array.isArray(scanData.pairs)) {
      return {
        label: "Hot Pairs",
        count: scanData.pairs.length,
        rows: scanData.pairs.slice(0, 3).map((item: any) => {
          const marketCap = Number(item?.marketCapUsd || 0);
          const fallbackVolume = Number(item?.volumeUsd || item?.liquidityUsd || 0);
          const metricLabel = marketCap > 0 ? `MC $${Math.round(marketCap).toLocaleString("en-US")}` : `VOL $${Math.round(fallbackVolume).toLocaleString("en-US")}`;
          return {
            label: `${item?.symbol || item?.name || shortenAddress(item?.tokenAddress)} · ${metricLabel}`,
            tokenAddress: String(item?.tokenAddress || ""),
          };
        }),
        lines: [] as string[],
      };
    }
    if (scanData.regime || scanData.regimeLabel || scanData.marketRegime) {
      const regime = scanData.regime || scanData.regimeLabel || scanData.marketRegime;
      const confidence = Number(scanData.confidence || 0);
      return {
        label: "Market Regime",
        count: null,
        rows: [] as Array<{ label: string; tokenAddress: string }>,
        lines: [String(regime), `Confidence: ${Math.round(confidence * 100)}%`],
      };
    }
    return {
      label: "Result",
      count: null,
      rows: [] as Array<{ label: string; tokenAddress: string }>,
      lines: [JSON.stringify(scanData).slice(0, 120)],
    };
  }, [scanData]);

  const thesisMutation = useMutation({
    mutationFn: async (tokenAddress: string) => {
      const res = await apiRequest("POST", "/api/thesis/build", {
        walletId: wallet?.id,
        tokenAddress,
      });
      return res.json();
    },
    onError: (err: Error) => {
      toast({ title: "Thesis build failed", description: err.message, variant: "destructive" });
    },
  });

  useEffect(() => {
    if (runtimePreviewPaused) return;

    const id = window.setInterval(() => {
      setRuntimePreviewNow(Date.now());
    }, 1000);

    return () => window.clearInterval(id);
  }, [runtimePreviewPaused]);

  if (walletsLoading || capitalLoading) {
    return (
      <div className="p-6 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {(["balance", "unrealized", "realized", "total"] as const).map((k) => (
            <Card key={k}><CardContent className="p-4"><Skeleton className="h-20 w-full" /></CardContent></Card>
          ))}
        </div>
      </div>
    );
  }

  const balanceSol = Number(capital?.balanceSol ?? (wallet ? wallet.balanceLamports / 1e9 : 0));
  const solPriceUsd = Number(capital?.solPriceUsd ?? 0);
  const hasSolPrice = solPriceUsd > 0;
  const totalRealized = Number(capital?.totalRealizedPnl ?? 0);
  const totalPnl = totalUnrealized + totalRealized;
  const usageLimits = entitlementData?.limits ?? capital?.limits ?? null;
  const kafka = systemStatus?.kafka;
  const msgPerSecCap = Number(usageLimits?.msgPerSec || 0);
  const msgPerSecNow = Number(kafka?.throughputMsgs || 0);
  const throughputCapKbps = Number(usageLimits?.kbps || 0);
  const throughputNowKbps = Number(kafka?.throughputKbps || 0);
  const strategyWeights = strategyState?.featureWeights && Object.keys(strategyState.featureWeights).length > 0
    ? strategyState.featureWeights
    : null;
  const activeRuntimePreview = Array.isArray(entitlementData?.activeEntitlements)
    ? entitlementData.activeEntitlements[0]
    : null;
  const activeRuntimeExpiryMs = activeRuntimePreview?.expiresAt
    ? new Date(activeRuntimePreview.expiresAt).getTime()
    : Number.NaN;
  const activeRuntimeInfinite = !!activeRuntimePreview && !Number.isFinite(activeRuntimeExpiryMs);
  const fallbackRuntimeSecondsRemaining = Math.max(
    0,
    RUNTIME_PREVIEW_FALLBACK_SECONDS - Math.floor((runtimePreviewNow - runtimePreviewStartedAt) / 1000)
  );
  const runtimePreviewSecondsRemaining = activeRuntimePreview
    ? activeRuntimeInfinite
      ? null
      : Math.max(0, Math.floor((activeRuntimeExpiryMs - runtimePreviewNow) / 1000))
    : fallbackRuntimeSecondsRemaining;
  const runtimePreviewPlanLabel = activeRuntimePreview?.planCode
    ? String(activeRuntimePreview.planCode).replace(/_/g, " ")
    : "Runtime preview";
  const runtimePreviewCountdown = formatRuntimePreviewCountdown(runtimePreviewSecondsRemaining);
  const runtimePreviewStateLabel = runtimePreviewPaused
    ? "Paused"
    : activeRuntimePreview
      ? "Live"
      : "Simulated";
  const runtimePreviewStateTone = runtimePreviewPaused
    ? "hsl(var(--muted-foreground))"
    : "hsl(var(--primary))";
  const runtimePreviewSupportCopy = activeRuntimePreview
    ? activeRuntimeInfinite
      ? "Active runtime is open-ended on this wallet right now."
      : `Ends ${new Date(activeRuntimePreview.expiresAt).toLocaleString()}.`
    : "Using a staged dashboard timer until a runtime plan is attached.";
  const referralPreviewCode = referralPreview?.referralCode?.trim().toUpperCase() || "TCLAW-INVITE";
  const referralPreviewStatus = referralPreview
    ? referralPreview.referralProgramEnabled
      ? "Active"
      : "Preview"
    : "Preview";
  const referralPreviewTier = referralPreview?.referralTier || "Operator";
  const referralPreviewFeeShare = Number.isFinite(referralPreview?.referralPercentage)
    ? `${referralPreview?.referralPercentage}%`
    : "5%";
  const referralPreviewWaitlist = referralPreview?.waitlistSyncedAt
    ? `Linked ${new Date(referralPreview.waitlistSyncedAt).toLocaleDateString()}`
    : "Link open";

  const handleCopyReferralCode = async () => {
    await navigator.clipboard.writeText(referralPreviewCode);
    toast({ title: "Referral code copied" });
  };

  const handleInviteReferral = async () => {
    const inviteText = `Join TraderClaw with my referral code ${referralPreviewCode}.`;
    const inviteUrl = "https://traderclaw.ai";

    if (navigator.share) {
      try {
        await navigator.share({
          title: "TraderClaw referral",
          text: inviteText,
          url: inviteUrl,
        });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
      }
    }

    await navigator.clipboard.writeText(`${inviteText} ${inviteUrl}`);
    toast({ title: "Invite copied" });
  };

  return (
    <div className="space-y-5 px-4 py-4 sm:px-6 sm:py-6">

      {/* Page header */}
      <DashboardMotion delay={0} distance={10}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1
              className="text-2xl font-bold tracking-[0.02em]"
              data-testid="text-page-title"
              style={{ ...TITLE_FONT, color: "hsl(var(--foreground))" }}
            >
              Dashboard
            </h1>
          </div>
        </div>
      </DashboardMotion>

      {isAdmin && (
        <DashboardMotion delay={0.04} hover>
          <Card data-testid="card-admin-kpis" className="group/card border-0 card-glow">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="flex flex-col gap-2 text-sm font-medium tracking-[0.04em] sm:flex-row sm:items-center sm:justify-between" style={MONO_FONT}>
                <span>Admin Mode · Production KPIs</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-[10px] tracking-wider"
                  disabled={adminKpisRefreshing}
                  onClick={async () => {
                    await refetchAdminKpis();
                    toast({ title: "Admin KPIs refreshed" });
                  }}
                >
                  <RefreshCw className={`w-3 h-3 mr-1 ${adminKpisRefreshing ? "animate-spin" : ""}`} />
                  Bitquery on-demand
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2 text-xs">
                {[
                  { label: "Installs", value: Number(adminKpis?.installs || 0).toLocaleString("en-US") },
                  { label: "Active Claws", value: Number(adminKpis?.activeClaws || 0).toLocaleString("en-US") },
                  { label: "Trades Executed", value: Number(adminKpis?.tradesExecuted || 0).toLocaleString("en-US") },
                  { label: "Wallets Funded", value: Number(adminKpis?.walletsFunded || 0).toLocaleString("en-US") },
                  { label: "Volume Generated", value: formatUsd(Number(adminKpis?.volumeGeneratedUsd || 0)) },
                  {
                    label: "Milestone Progress",
                    value: `${Number(adminKpis?.milestoneProgress?.progressPct || 0).toFixed(0)}%`,
                  },
                  {
                    label: "Bitquery Usage",
                    value: `${Number(adminKpis?.bitqueryUsage?.requestCount || 0).toLocaleString("en-US")} req`,
                  },
                  {
                    label: "Websockets Active",
                    value: `${Number(adminKpis?.websocketsActive?.connected || 0)} (${Number(adminKpis?.websocketsActive?.authenticated || 0)} auth)`,
                  },
                ].map((item) => (
                  <div
                    key={item.label}
                    className="rounded-sm p-2"
                    style={{ background: "hsl(var(--surface-1))", border: "1px solid hsl(var(--border))" }}
                  >
                    <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground" style={MONO_FONT}>{item.label}</div>
                    <div className="mt-1 text-base font-bold" style={MONO_FONT}>{item.value}</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </DashboardMotion>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <DashboardMotion delay={0.08} distance={14} hover>
          <Card data-testid="card-runtime-preview" className="group/card border-0 card-glow h-full">
            <CardHeader className="pb-2 pt-4 px-4">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div
                    className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
                    style={MONO_FONT}
                  >
                    Access
                  </div>
                  <CardTitle
                    className="text-sm font-medium tracking-[0.04em] flex items-center gap-2"
                    style={MONO_FONT}
                  >
                    <DashboardIconBadge icon={Clock} className="h-8 w-8" />
                    Runtime
                  </CardTitle>
                </div>
                <Badge
                  variant="outline"
                  className="px-2.5 py-1 text-[9px] uppercase tracking-[0.14em]"
                  style={{ ...MONO_FONT, color: runtimePreviewStateTone }}
                >
                  {runtimePreviewStateLabel}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
                <div className="space-y-2">
                  <div
                    className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
                    style={MONO_FONT}
                  >
                    Remaining
                  </div>
                  <div
                    className="text-[1.7rem] font-semibold leading-none text-foreground sm:text-[1.9rem]"
                    style={MONO_FONT}
                    data-testid="text-dashboard-runtime-countdown"
                  >
                    {runtimePreviewCountdown}
                  </div>
                </div>
                <div className="space-y-2 md:text-right">
                  <div
                    className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
                    style={MONO_FONT}
                  >
                    Plan
                  </div>
                  <div className="text-sm text-foreground" style={BODY_FONT}>
                    {runtimePreviewPlanLabel}
                  </div>
                </div>
              </div>

              <p className="mt-4 text-sm leading-6 text-muted-foreground" style={BODY_FONT}>
                {runtimePreviewSupportCopy}
              </p>

              <div className="mt-4 grid grid-cols-1 gap-3 border-t border-border/70 pt-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <div
                    className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
                    style={MONO_FONT}
                  >
                    Mode
                  </div>
                  <div className="text-sm text-foreground" style={BODY_FONT}>
                    {runtimePreviewPaused ? "Countdown paused" : "Runtime ticking"}
                  </div>
                </div>
                <div className="space-y-1">
                  <div
                    className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
                    style={MONO_FONT}
                  >
                    Buy rail
                  </div>
                  <div className="text-sm text-foreground" style={BODY_FONT}>
                    SOL live / $TCLAW staged
                  </div>
                </div>
              </div>

              <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <button
                  type="button"
                  data-testid="button-dashboard-runtime-toggle"
                  className="inline-flex min-h-9 items-center justify-center gap-2 border border-border bg-muted/15 px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-foreground transition-colors hover:border-primary/30 hover:bg-primary/6"
                  style={MONO_FONT}
                  onClick={() => setRuntimePreviewPaused((value) => !value)}
                >
                  {runtimePreviewPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                  {runtimePreviewPaused ? "Play" : "Pause"}
                </button>
                <button
                  type="button"
                  data-testid="button-dashboard-buy-runtime"
                  className="inline-flex min-h-9 items-center justify-center gap-2 border border-border bg-muted/15 px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-foreground transition-colors hover:border-primary/30 hover:bg-primary/6"
                  style={MONO_FONT}
                  onClick={() => { window.location.href = "/runtime"; }}
                >
                  Add / Buy runtime
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </CardContent>
          </Card>
        </DashboardMotion>

        <DashboardMotion delay={0.12} distance={14} hover>
          <Card data-testid="card-referral-preview" className="group/card border-0 card-glow h-full">
            <CardHeader className="pb-2 pt-4 px-4">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div
                    className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
                    style={MONO_FONT}
                  >
                    Access
                  </div>
                  <CardTitle
                    className="text-sm font-medium tracking-[0.04em] flex items-center gap-2"
                    style={MONO_FONT}
                  >
                    <DashboardIconBadge icon={Gift} className="h-8 w-8" />
                    Referral Program
                  </CardTitle>
                </div>
                <Badge
                  variant="outline"
                  className="px-2.5 py-1 text-[9px] uppercase tracking-[0.14em] text-primary"
                  style={MONO_FONT}
                >
                  {referralPreviewStatus}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="space-y-2">
                <div
                  className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
                  style={MONO_FONT}
                >
                  Referral code
                </div>
                <div
                  className="break-all text-[1.55rem] font-semibold leading-none text-foreground sm:text-[1.75rem]"
                  style={MONO_FONT}
                  data-testid="text-dashboard-referral-code"
                >
                  {referralPreviewCode}
                </div>
              </div>

              <p className="mt-4 text-sm leading-6 text-muted-foreground" style={BODY_FONT}>
                Share your code directly from the dashboard, then jump into the dedicated referral surface for the full program controls.
              </p>

              <div className="mt-4 grid grid-cols-1 gap-3 border-t border-border/70 pt-4 sm:grid-cols-3">
                <div className="space-y-1">
                  <div
                    className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
                    style={MONO_FONT}
                  >
                    Fee share
                  </div>
                  <div className="text-sm text-foreground" style={BODY_FONT}>
                    {referralPreviewFeeShare}
                  </div>
                </div>
                <div className="space-y-1">
                  <div
                    className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
                    style={MONO_FONT}
                  >
                    Tier
                  </div>
                  <div className="text-sm text-foreground" style={BODY_FONT}>
                    {referralPreviewTier}
                  </div>
                </div>
                <div className="space-y-1">
                  <div
                    className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
                    style={MONO_FONT}
                  >
                    Waitlist
                  </div>
                  <div className="text-sm text-foreground" style={BODY_FONT}>
                    {referralPreviewWaitlist}
                  </div>
                </div>
              </div>

              <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <button
                  type="button"
                  data-testid="button-dashboard-copy-referral"
                  className="inline-flex min-h-9 items-center justify-center gap-2 border border-border bg-muted/15 px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-foreground transition-colors hover:border-primary/30 hover:bg-primary/6"
                  style={MONO_FONT}
                  onClick={handleCopyReferralCode}
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy code
                </button>
                <button
                  type="button"
                  data-testid="button-dashboard-invite-referral"
                  className="inline-flex min-h-9 items-center justify-center gap-2 border border-border bg-muted/15 px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-foreground transition-colors hover:border-primary/30 hover:bg-primary/6"
                  style={MONO_FONT}
                  onClick={handleInviteReferral}
                >
                  Invite
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </CardContent>
          </Card>
        </DashboardMotion>
      </div>

      {/* ── STAT CARDS ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">

        {/* Wallet Balance */}
        <DashboardMotion delay={0.08} hover>
          <StatCard testId="card-wallet-balance">
            <div className="flex h-full flex-col p-4">
              <div className="flex items-center justify-between mb-3">
                <span
                  className="text-xs tracking-[0.12em] uppercase"
                  style={{ ...MONO_FONT, color: "hsl(var(--muted-foreground))" }}
                >
                  Wallet Balance
                </span>
                <DashboardIconBadge icon={Wallet} className="h-9 w-9" />
              </div>
              <div className="text-2xl font-bold tabular-nums" style={{ ...MONO_FONT, color: "hsl(var(--foreground))" }}>
                <SolAmount
                  value={formatSol(balanceSol)}
                  className="text-2xl font-bold tabular-nums"
                  valueClassName="font-mono text-foreground"
                  markClassName="h-[0.8em] w-[0.8em]"
                />
              </div>
              <div className="mt-1 text-sm text-muted-foreground" style={BODY_FONT}>{hasSolPrice ? formatUsd(balanceSol * solPriceUsd) : "—"}</div>
              <div className="mt-auto flex flex-col gap-3 pt-4 sm:flex-row sm:items-end sm:justify-between">
                <div className="text-xs text-muted-foreground tabular-nums" style={MONO_FONT}>
                  {capital?.liveBalanceRefreshedAt
                    ? `Updated ${new Date(capital.liveBalanceRefreshedAt).toLocaleTimeString()}`
                    : capitalRefreshing
                      ? "Refreshing…"
                      : "NOT YET FETCHED"}
                </div>
                <button
                  type="button"
                  data-testid="button-refresh-balance"
                  disabled={capitalRefreshing || !wallet?.id}
                  title="Refresh live balance"
                  className="inline-flex w-full items-center justify-center gap-1.5 border border-border bg-muted/20 px-2.5 py-1.5 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:border-border hover:bg-muted/35 hover:text-foreground disabled:opacity-40 sm:w-auto"
                  style={{ fontFamily: "var(--font-sans)" }}
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (!wallet?.id) return;
                    await refetchCapital();
                    await queryClient.invalidateQueries({ queryKey: ["/api/wallets"] });
                    toast({ title: "Balance refreshed" });
                  }}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${capitalRefreshing ? "animate-spin" : ""}`} />
                  Sync Balance
                </button>
              </div>
            </div>
          </StatCard>
        </DashboardMotion>

        {/* Unrealized PnL */}
        <DashboardMotion delay={0.13} hover>
          <StatCard testId="card-unrealized-pnl">
            <div className="flex h-full flex-col p-4">
              <div className="flex items-center justify-between mb-3">
                <span
                  className="text-xs tracking-[0.12em] uppercase"
                  style={{ ...MONO_FONT, color: "hsl(var(--muted-foreground))" }}
                >
                  Unrealized PnL
                </span>
                <DashboardIconBadge
                  icon={totalUnrealized >= 0 ? TrendingUp : TrendingDown}
                  tone={totalUnrealized >= 0 ? "profit" : "loss"}
                  className="h-9 w-9"
                />
              </div>
              <div className="text-2xl font-bold"><PnlText value={totalUnrealized} showUnit /></div>
              <div className="mt-auto pt-4 text-sm text-muted-foreground" style={BODY_FONT}>{hasSolPrice ? <PnlText value={totalUnrealized * solPriceUsd} /> : "—"}</div>
            </div>
          </StatCard>
        </DashboardMotion>

        {/* Realized PnL */}
        <DashboardMotion delay={0.18} hover>
          <StatCard testId="card-realized-pnl">
            <div className="flex h-full flex-col p-4">
              <div className="flex items-center justify-between mb-3">
                <span
                  className="text-xs tracking-[0.12em] uppercase"
                  style={{ ...MONO_FONT, color: "hsl(var(--muted-foreground))" }}
                >
                  Realized PnL
                </span>
                <DashboardIconBadge icon={ChartLineUp} className="h-9 w-9" />
              </div>
              <div className="text-2xl font-bold"><PnlText value={totalRealized} showUnit /></div>
              <div className="mt-auto pt-4 text-sm text-muted-foreground" style={BODY_FONT}>{hasSolPrice ? <PnlText value={totalRealized * solPriceUsd} /> : "—"}</div>
            </div>
          </StatCard>
        </DashboardMotion>

        {/* Total PnL */}
        <DashboardMotion delay={0.23} hover>
          <StatCard testId="card-total-pnl">
            <div className="flex h-full flex-col p-4">
              <div className="flex items-center justify-between mb-3">
                <span
                  className="text-xs tracking-[0.12em] uppercase"
                  style={{ ...MONO_FONT, color: "hsl(var(--muted-foreground))" }}
                >
                  Total PnL
                </span>
                <DashboardIconBadge icon={ChartPieSlice} className="h-9 w-9" />
              </div>
              <div className="text-2xl font-bold"><PnlText value={totalPnl} showUnit /></div>
              <div className="mt-auto pt-4 text-sm text-muted-foreground" style={BODY_FONT}>{capital?.openPositionCount ?? 0} open positions</div>
            </div>
          </StatCard>
        </DashboardMotion>
      </div>

      {/* ── POSITIONS + CONTROLS ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Open positions table */}
        <DashboardMotion className="lg:col-span-2" delay={0.2} distance={18} hover>
          <Card
            className="group/card h-full card-glow border-0"
            data-testid="card-open-positions"
          >
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle
                className="text-sm font-medium tracking-[0.04em] flex items-center gap-2"
                style={{ ...MONO_FONT, color: "hsl(var(--foreground))" }}
              >
                <DashboardIconBadge icon={Rows} className="h-8 w-8" />
                Open Positions
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {!positions || positions.length === 0 ? (
                <EmptyState
                  icon={Rows}
                  title="No open positions"
                  description="Active trades will appear here once the agent enters a position."
                  compact
                  framed={false}
                  className="py-10"
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr style={{ borderBottom: "1px solid hsl(var(--border))" }}>
                        {(
                          [
                            { col: "Token", align: "text-left" },
                            { col: "Size", align: "text-right" },
                            { col: "Entry", align: "text-right" },
                            { col: "Current", align: "text-right" },
                            { col: "uPnL", align: "text-center" },
                            { col: "Mode", align: "text-center" },
                            { col: "SL/TP", align: "text-center" },
                          ] as { col: string; align: string }[]
                        ).map(({ col, align }) => (
                          <th
                            key={col}
                            className={`px-1 py-2.5 text-xs uppercase font-medium tracking-[0.12em] ${align}`}
                            style={{ ...MONO_FONT, color: "hsl(var(--muted-foreground))" }}
                          >
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {positions.map((pos) => (
                        (() => {
                          const slLevels = (pos as any)?.slLevels as Array<{ percent: number; amount: number }> | undefined;
                          const tpLevelsDetailed = (pos as any)?.tpLevelsDetailed as Array<{ percent: number; amount: number }> | undefined;
                          const slLabel = slLevels?.length
                            ? slLevels.map((l) => `SL${l.percent}%(${l.amount}%)`).join(" / ")
                            : `${pos.slPct}%`;
                          const tpLabel = tpLevelsDetailed?.length
                            ? tpLevelsDetailed.map((l) => `TP${l.percent}%(${l.amount}%)`).join(", ")
                            : (pos.tpLevels ? (pos.tpLevels as number[]).join(",") : "-");
                          return (
                        <tr
                          key={pos.id}
                          data-testid={`row-position-${pos.id}`}
                          className="transition-colors"
                          style={{ borderBottom: "1px solid hsl(var(--border) / 0.5)" }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = "hsl(var(--muted) / 0.35)"; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = "transparent"; }}
                        >
                          <td className="py-2.5 px-1 font-semibold" style={BODY_FONT}>
                            <div className="flex items-center gap-1">
                              <span>{pos.symbol}</span>
                              {pos.tokenAddress ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="h-5 w-5 p-0 hover:bg-primary/10 shrink-0"
                                  title="Copy token address"
                                  onClick={async () => {
                                    await navigator.clipboard.writeText(pos.tokenAddress);
                                    toast({ title: "Token address copied" });
                                  }}
                                >
                                  <Copy className="w-3 h-3" />
                                </Button>
                              ) : null}
                            </div>
                          </td>
                          <td className="py-2.5 px-1 text-right" style={MONO_FONT}>{formatSol(pos.sizeSol)}</td>
                          <td className="py-2.5 px-1 text-right" style={MONO_FONT}>{pos.entryPrice.toPrecision(4)}</td>
                          <td className="py-2.5 px-1 text-right" style={MONO_FONT}>{pos.currentPrice.toPrecision(4)}</td>
                          <td className="py-2.5 px-1 text-right"><PnlText value={pos.unrealizedPnl} /></td>
                          <td className="py-2.5 px-1 text-center">
                            <Badge
                              variant="outline"
                              className="text-[10px] border-primary/30 text-primary"
                              style={MONO_FONT}
                            >
                              {pos.managementMode === "SERVER_MANAGED" ? "SRV" : "LCL"}
                            </Badge>
                          </td>
                          <td className="py-2.5 px-1 text-center text-muted-foreground" style={MONO_FONT}>
                            {slLabel} / {tpLabel}
                          </td>
                        </tr>
                          );
                        })()
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </DashboardMotion>

        {/* Right column: kill switch + quick actions */}
        <div className="space-y-4">

          {/* Kill switch */}
          <DashboardMotion delay={0.25} distance={18} hover>
            <Card
              data-testid="card-killswitch"
              className="group/card border-0 card-glow"
            >
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle
                  className="text-sm font-medium tracking-[0.04em] flex items-center gap-2"
                  style={MONO_FONT}
                >
                  <DashboardIconBadge icon={Power} className="h-8 w-8" />
                  Kill Switch
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 px-4 pb-4">
                <div className="flex items-center justify-between gap-3 border border-border bg-muted/10 px-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={`inline-flex h-6 items-center border px-2 text-[10px] font-medium uppercase tracking-[0.18em] ${
                        killSwitch?.enabled
                          ? "border-loss/30 bg-loss/10 text-loss"
                          : "border-border/80 bg-transparent text-muted-foreground"
                      }`}
                      style={MONO_FONT}
                    >
                      {killSwitch?.enabled ? "Enabled" : "Disabled"}
                    </span>
                    <span className="text-xs uppercase tracking-[0.12em] text-muted-foreground" style={MONO_FONT}>
                      Kill trades only
                    </span>
                  </div>
                  <Switch
                    data-testid="switch-killswitch"
                    checked={killSwitch?.enabled ?? false}
                    disabled={killSwitchMutation.isPending}
                    onCheckedChange={(checked) => killSwitchMutation.mutate({
                      enabled: checked,
                      mode: killSwitch?.mode ?? "TRADES_ONLY",
                    })}
                  />
                </div>
                <Select
                  value={killSwitch?.mode ?? "TRADES_ONLY"}
                  disabled={killSwitchMutation.isPending}
                  onValueChange={(mode) => killSwitchMutation.mutate({
                    enabled: killSwitch?.enabled ?? false,
                    mode,
                  })}
                >
                  <SelectTrigger data-testid="select-killswitch-mode" className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TRADES_ONLY">Trades Only</SelectItem>
                  </SelectContent>
                </Select>
                {killSwitchMutation.isPending ? (
                  <div className="text-xs text-muted-foreground tracking-[0.12em] uppercase" style={MONO_FONT}>
                    Syncing…
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </DashboardMotion>

          {/* CTA cards */}
          <DashboardMotion delay={0.3} distance={18} hover>
            <Card
              data-testid="card-cta-risk"
              className="group/card border-0 card-glow cursor-pointer transition-colors"
              onClick={() => window.location.href = '/risk-strategy'}
            >
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-medium tracking-[0.04em] flex items-center gap-2" style={MONO_FONT}>
                  <DashboardIconBadge icon={ShieldCheckered} className="h-8 w-8" />
                  Risk Strategy
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 px-4 pb-4">
                <p className="text-sm leading-6 text-muted-foreground" style={BODY_FONT}>Configure TP / SL / trailing stop defaults and enforcement mode.</p>
                <Button size="sm" variant="outline" className="h-7 text-xs mt-1 border-border hover:border-border hover:bg-muted/35" onClick={() => window.location.href = '/risk-strategy'}>
                  Configure →
                </Button>
              </CardContent>
            </Card>
          </DashboardMotion>

          <DashboardMotion delay={0.35} distance={18} hover>
            <Card
              data-testid="card-cta-buy"
              className="group/card border-0 card-glow cursor-pointer transition-colors"
              onClick={() => window.location.href = '/buy-strategy'}
            >
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-medium tracking-[0.04em] flex items-center gap-2" style={MONO_FONT}>
                  <DashboardIconBadge icon={SlidersHorizontal} className="h-8 w-8" />
                  Buy Strategy
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 px-4 pb-4">
                <p className="text-sm leading-6 text-muted-foreground" style={BODY_FONT}>Set buy filter bounds, enforcement mode, and per-token limits.</p>
                <Button size="sm" variant="outline" className="h-7 text-xs mt-1 border-border hover:border-border hover:bg-muted/35" onClick={() => window.location.href = '/buy-strategy'}>
                  Configure →
                </Button>
              </CardContent>
            </Card>
          </DashboardMotion>

          <DashboardMotion delay={0.4} distance={18} hover>
            <Card
              data-testid="card-cta-alpha"
              className="group/card border-0 card-glow cursor-pointer transition-colors"
              onClick={() => window.location.href = '/alpha'}
            >
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-medium tracking-[0.04em] flex items-center gap-2" style={MONO_FONT}>
                  <DashboardIconBadge icon={Waveform} className="h-8 w-8" />
                  Alpha Filters
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 px-4 pb-4">
                <p className="text-sm leading-6 text-muted-foreground" style={BODY_FONT}>Select alpha sources and configure signal filters (mcap, liquidity, holders, etc.).</p>
                <Button size="sm" variant="outline" className="h-7 text-xs mt-1 border-border hover:border-border hover:bg-muted/35" onClick={() => window.location.href = '/alpha'}>
                  Configure →
                </Button>
              </CardContent>
            </Card>
          </DashboardMotion>

          {/* Legacy quick actions — hidden, kept for reference */}
          <div style={{ display: 'none' }}>
          <Card
            data-testid="card-quick-actions-hidden"
            className="border-0 card-glow"
          >
            <CardContent className="space-y-2 px-4 pb-4">
              <div className="flex gap-1">
                <Input
                  data-testid="input-thesis-token"
                  placeholder="Token address..."
                  value={thesisToken}
                  onChange={(e) => setThesisToken(e.target.value)}
                  className="h-8 text-xs"
                  style={MONO_FONT}
                />
                <Button
                  data-testid="button-build-thesis"
                  variant="default"
                  size="sm"
                  className="h-8 px-3 bg-primary hover:bg-primary/90"
                  onClick={() => {
                    if (thesisToken.trim()) thesisMutation.mutate(thesisToken.trim());
                  }}
                  disabled={thesisMutation.isPending || !thesisToken.trim()}
                >
                  <Search className="w-3.5 h-3.5" />
                </Button>
              </div>
              {thesisMutation.isPending && (
                <div className="text-xs text-muted-foreground tracking-[0.12em] uppercase" style={MONO_FONT}>
                  Building thesis…
                </div>
              )}
              {thesisMutation.data && <ThesisPackageView data={thesisMutation.data} />}
              {scanSummary && (
                <div className="rounded border border-primary/20 bg-primary/5 p-2 text-xs space-y-1" style={MONO_FONT}>
                  <div className="flex items-center justify-between">
                    <span className="uppercase tracking-[0.12em] text-muted-foreground" style={MONO_FONT}>{scanSummary.label}</span>
                    {scanSummary.count != null ? <Badge variant="outline" className="text-[10px]">{scanSummary.count}</Badge> : null}
                  </div>
                  {scanSummary.rows?.length > 0
                    ? scanSummary.rows.map((row: { label: string; tokenAddress: string }) => (
                        <div key={`${row.tokenAddress}-${row.label}`} className="flex items-center justify-between gap-2">
                          <div className="truncate">{row.label}</div>
                          {row.tokenAddress ? (
                            <div className="flex items-center gap-1 shrink-0">
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-5 w-5 p-0 hover:bg-primary/10"
                                title="Copy token address"
                                onClick={async () => {
                                  await navigator.clipboard.writeText(row.tokenAddress);
                                  toast({ title: "Token address copied" });
                                }}
                              >
                                <Copy className="w-3 h-3" />
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-5 w-5 p-0 hover:bg-primary/10"
                                title="Open on Dexscreener"
                                onClick={() => {
                                  const url = toDexscreenerUrl(row.tokenAddress);
                                  if (url) window.open(url, "_blank", "noopener,noreferrer");
                                }}
                              >
                                <ExternalLink className="w-3 h-3" />
                              </Button>
                            </div>
                          ) : null}
                        </div>
                      ))
                    : scanSummary.lines.map((line: string) => (
                        <div key={line} className="truncate">{line}</div>
                      ))}
                </div>
              )}
              <div className="flex gap-1 pt-1">
                {[
                  { id: "button-scan-launches", label: "Launches", icon: Rocket, endpoint: "/api/scan/new-launches" },
                  { id: "button-scan-hot-pairs", label: "Hot Pairs", icon: Flame, endpoint: "/api/scan/hot-pairs" },
                  { id: "button-market-regime", label: "Regime", icon: Activity, endpoint: "/api/market/regime" },
                ].map(({ id, label, icon: Icon, endpoint }) => (
                  <Button
                    key={id}
                    data-testid={id}
                    variant="outline"
                    size="sm"
                    className="flex-1 h-7 text-xs tracking-[0.12em] border-primary/20 hover:border-primary/50 hover:bg-primary/5 hover:text-primary"
                    style={MONO_FONT}
                    onClick={() => scanMutation.mutate(endpoint)}
                    disabled={scanMutation.isPending}
                  >
                    <Icon className="w-3 h-3 mr-1" />
                    {label}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>
          </div>{/* end hidden legacy quick actions */}
        </div>
      </div>

      {/* ── ENTITLEMENTS / USAGE / KAFKA — removed ── */}
      <div style={{ display: 'none' }} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">

        {/* Entitlements */}
        <Card data-testid="card-entitlement-status" className="border-0 card-glow">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle
              className="text-sm font-medium tracking-[0.04em] flex items-center gap-2"
              style={MONO_FONT}
            >
              <Crown className="w-3.5 h-3.5 text-foreground" />
              Entitlements
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 px-4 pb-4">
            {entitlementData?.activeEntitlements?.length > 0 ? (
              entitlementData.activeEntitlements.map((ent: any) => (
                <div key={ent.id} className="flex items-center justify-between text-xs" data-testid={`entitlement-${ent.id}`}>
                  <span className="text-muted-foreground">{ent.planCode.replace(/_/g, " ")}</span>
                  <Badge
                    variant="outline"
                    className="text-[10px] border-primary/30 text-primary"
                    style={MONO_FONT}
                  >
                    {Math.max(0, Math.round((new Date(ent.expiresAt).getTime() - Date.now()) / 3600000))}h left
                  </Badge>
                </div>
              ))
            ) : (
              <EmptyState
                icon={Crown}
                title="No active entitlements"
                description="Live access windows and limits will appear here once an entitlement is active."
                compact
                framed={false}
                className="py-6"
              />
            )}
          </CardContent>
        </Card>

        {/* Usage vs limits */}
        <Card data-testid="card-usage-limits" className="border-0 card-glow">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle
              className="text-sm font-medium tracking-[0.04em] flex items-center gap-2"
              style={MONO_FONT}
            >
              <ArrowUpRight className="w-3.5 h-3.5 text-foreground" />
              Usage vs Limits
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 px-4 pb-4">
            {usageLimits && (
              <>
                {[
                  {
                    label: "Daily Notional",
                    value: `${formatUsd((capital?.dailyNotionalSol ?? 0) * solPriceUsd)} / ${formatUsd(usageLimits.maxDailyNotionalUsd || 0)}`,
                    progress: hasSolPrice && Number(usageLimits.maxDailyNotionalUsd || 0) > 0
                      ? (((capital?.dailyNotionalSol ?? 0) * solPriceUsd) / usageLimits.maxDailyNotionalUsd) * 100
                      : 0,
                  },
                  {
                    label: "Msg/sec",
                    value: msgPerSecCap > 0 ? `${msgPerSecNow.toFixed(2)} / ${msgPerSecCap}` : `${msgPerSecNow.toFixed(2)}`,
                    progress: msgPerSecCap > 0 ? (msgPerSecNow / msgPerSecCap) * 100 : 0,
                  },
                  {
                    label: "Throughput",
                    value:
                      throughputCapKbps > 0
                        ? `${throughputNowKbps.toFixed(2)} / ${throughputCapKbps} kbps`
                        : `${throughputNowKbps.toFixed(2)} kbps`,
                    progress: throughputCapKbps > 0 ? (throughputNowKbps / throughputCapKbps) * 100 : 0,
                  },
                ].map(({ label, value, progress }) => (
                  <div key={label} className="space-y-1.5">
                    <div className="flex justify-between text-xs">
                      <span
                        className="text-xs tracking-[0.12em] uppercase"
                        style={{ ...MONO_FONT, color: "hsl(var(--muted-foreground))" }}
                      >
                        {label}
                      </span>
                      <span style={MONO_FONT}>{value}</span>
                    </div>
                    <Progress value={progress} className="h-1" />
                  </div>
                ))}
              </>
            )}
          </CardContent>
        </Card>

        {/* Kafka throughput */}
        <Card data-testid="card-kafka-status" className="border-0 card-glow">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle
              className="text-sm font-medium tracking-[0.04em] flex items-center gap-2"
              style={MONO_FONT}
            >
              <Zap className="w-3.5 h-3.5 text-foreground" />
              Kafka Throughput
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 px-4 pb-4">
            {kafka ? (
              <>
                {[
                  ["Messages/s", kafka.throughputMsgs],
                  ["Throughput", `${kafka.throughputKbps} kbps`],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between text-xs">
                    <span
                      className="text-xs tracking-[0.12em] uppercase"
                      style={{ ...MONO_FONT, color: "hsl(var(--muted-foreground))" }}
                    >
                      {label}
                    </span>
                    <span style={MONO_FONT}>{value}</span>
                  </div>
                ))}
                <div className="flex justify-between text-xs items-center">
                  <span
                    className="text-xs tracking-[0.12em] uppercase"
                    style={{ ...MONO_FONT, color: "hsl(var(--muted-foreground))" }}
                  >
                    Status
                  </span>
                  <Badge
                    variant="outline"
                    className="text-[10px] border-profit/30"
                    style={{ ...MONO_FONT, color: "hsl(var(--profit))" }}
                  >
                    {kafka.status}
                  </Badge>
                </div>
                <div className="flex justify-between text-xs items-center">
                  <span className="text-xs tracking-[0.12em] uppercase" style={{ ...MONO_FONT, color: "hsl(var(--muted-foreground))" }}>
                    Heartbeat
                  </span>
                  <span style={MONO_FONT}>{kafka.heartbeatAt ? new Date(kafka.heartbeatAt).toLocaleTimeString() : "—"}</span>
                </div>
                <div className="mt-2">
                  <span
                    className="text-[10px] tracking-[0.12em] uppercase"
                    style={{ ...MONO_FONT, color: "hsl(var(--muted-foreground))" }}
                  >
                    Topics:
                  </span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {kafka.activeTopics?.map((t: string) => (
                      <Badge
                        key={t}
                        variant="secondary"
                        className="text-[9px] border-primary/20"
                        style={MONO_FONT}
                      >
                        {t.split(".").pop()}
                      </Badge>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <Skeleton className="h-20 w-full" />
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── STRATEGY WEIGHTS ── */}
      <DashboardMotion delay={0.46} distance={20} hover>
        <Card data-testid="card-strategy-state" className="group/card border-0 card-glow">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle
              className="text-sm font-medium tracking-[0.04em] flex items-center gap-2"
              style={MONO_FONT}
            >
              <DashboardIconBadge icon={Graph} className="h-8 w-8" />
              Agent Strategy Weights
              <span
                className="ml-auto text-[10px] font-normal tracking-[0.12em]"
                style={{ ...MONO_FONT, color: "hsl(var(--muted-foreground))" }}
              >
                Evolves via OpenClaw learning
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-5">
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
              {strategyWeights &&
                Object.entries(strategyWeights as Record<string, number>)
                  .sort(([, a], [, b]) => b - a)
                  .map(([key, val]) => (
                    <div
                      key={key}
                      className="text-center p-2 rounded-sm"
                      style={{ background: "hsl(var(--surface-1))", border: "1px solid hsl(var(--border))" }}
                      data-testid={`feature-weight-${key}`}
                    >
                      <div
                        className="text-xl font-black tabular-nums"
                        style={{ ...MONO_FONT, color: "hsl(var(--primary))" }}
                      >
                        {(val * 100).toFixed(0)}%
                      </div>
                      <div
                        className="mt-1 text-[10px] uppercase leading-tight tracking-[0.12em]"
                        style={{ ...MONO_FONT, color: "hsl(var(--muted-foreground))" }}
                      >
                        {key.replace(/_/g, " ")}
                      </div>
                    </div>
                  ))
              }
            </div>
            {!strategyWeights && (
              <EmptyState
                icon={Graph}
                title="No strategy weights yet"
                description="Weights auto-populate after the first eligible trading activity."
                compact
                framed={false}
                className="mt-4 py-6"
              />
            )}
          </CardContent>
        </Card>
      </DashboardMotion>
    </div>
  );
}
