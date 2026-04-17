import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Waveform,
  MessageCircle,
  Wallet,
  Lock,
  Unlock,
  ExternalLink,
  Filter,
  RefreshCw,
  CheckCircle2,
  Info,
} from "@/components/ui/icons";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Wallet as WalletType } from "@shared/schema";

// ─── Types ───────────────────────────────────────────────────────────────────

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

type PresetGroup = {
  id: string;
  groupName: string;
  displayName: string;
  groupId: string;
  agentTier: string | null;
  tiersValidFor: string[];
  isPremium: boolean;
  enabled: boolean;
};

type PrivateGroup = {
  id: string;
  groupName: string;
  displayName: string;
  groupId: string;
  isActive: boolean;
  enabled: boolean;
};

type PresetGroupsResponse = {
  ok: boolean;
  tier: string;
  accessTiers: string[];
  groups: PresetGroup[];
};

type PrivateGroupsResponse = {
  ok: boolean;
  telegramLinked: boolean;
  telegramUsername?: string | null;
  groups: PrivateGroup[];
};

type TradingPolicy = {
  riskEnforcement: string;
  buyFilterEnforcement: string;
  buyFilters: BuyFilterBounds;
  alphaFilters: BuyFilterBounds;
  onePurchasePerToken: boolean;
  alphaEnabledPresetGroupIds: string[] | null;
  alphaEnabledPrivateGroupIds: string[] | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FILTER_FIELDS: Array<{ key: keyof BuyFilterBounds; label: string; prefix?: string; suffix?: string }> = [
  { key: "minMarketCapUsd", label: "Min Market Cap", prefix: "$" },
  { key: "maxMarketCapUsd", label: "Max Market Cap", prefix: "$" },
  { key: "minVolumeUsd24h", label: "Min 24h Volume", prefix: "$" },
  { key: "maxVolumeUsd24h", label: "Max 24h Volume", prefix: "$" },
  { key: "minLiquidityUsd", label: "Min Liquidity", prefix: "$" },
  { key: "maxLiquidityUsd", label: "Max Liquidity", prefix: "$" },
  { key: "minHolders", label: "Min Holders" },
  { key: "maxHolders", label: "Max Holders" },
  { key: "maxTop10ConcentrationPct", label: "Max Top-10 Concentration", suffix: "%" },
  { key: "maxDevHoldingPct", label: "Max Dev Holding", suffix: "%" },
];

function FilterBoundsForm({
  bounds,
  onChange,
  disabled,
}: {
  bounds: BuyFilterBounds;
  onChange: (b: BuyFilterBounds) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {FILTER_FIELDS.map(({ key, label: fl, prefix, suffix }) => (
        <div key={key} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
          <span className="w-full shrink-0 text-xs text-muted-foreground sm:w-32">{fl}</span>
          <div className="relative w-full flex-1">
            {prefix && (
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                {prefix}
              </span>
            )}
            <Input
              type="number"
              min={0}
              disabled={disabled}
              value={bounds[key] ?? ""}
              placeholder="—"
              className={`text-xs h-7 ${prefix ? "pl-5" : ""} ${suffix ? "pr-7" : ""}`}
              onChange={(e) => {
                const raw = e.target.value;
                onChange({ ...bounds, [key]: raw === "" ? undefined : Number(raw) });
              }}
            />
            {suffix && (
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                {suffix}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function AlphaPage() {
  const { toast } = useToast();
  const [filterDraft, setFilterDraft] = useState<BuyFilterBounds | null>(null);
  const [deepLink, setDeepLink] = useState<string | null>(null);

  // Resolve first wallet (same pattern as other pages)
  const { data: wallets } = useQuery<WalletType[]>({ queryKey: ["/api/wallets"] });
  const wallet = wallets?.[0];
  const walletId = wallet?.id;

  // Trading policy — source of alphaFilters + enabled group ID lists
  const policyQueryKey = ["/api/wallet/trading-policy", walletId ? `?walletId=${walletId}` : ""];
  const { data: policy, isLoading: policyLoading } = useQuery<TradingPolicy>({
    queryKey: policyQueryKey,
    enabled: !!walletId,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/wallet/trading-policy?walletId=${walletId}`);
      return res.json();
    },
  });

  // Preset groups catalog
  const presetQueryKey = ["/api/alpha/preset-groups", walletId ? `?walletId=${walletId}` : ""];
  const { data: presetData, isLoading: presetLoading } = useQuery<PresetGroupsResponse>({
    queryKey: presetQueryKey,
    enabled: !!walletId,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/alpha/preset-groups?walletId=${walletId}`);
      return res.json();
    },
  });

  // Private groups (only available after Telegram link) — fetched live from Telegram via gramjs
  const privateQueryKey = ["/api/alpha/private-groups", walletId ? `?walletId=${walletId}` : ""];
  const { data: privateData, isLoading: privateLoading, isFetching: privateRefetching, refetch: refetchPrivate } = useQuery<PrivateGroupsResponse>({
    queryKey: privateQueryKey,
    enabled: !!walletId,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/alpha/private-groups?walletId=${walletId}`);
      return res.json();
    },
  });

  // Save policy mutation (used for both group toggles and filter changes)
  const savePolicyMutation = useMutation({
    mutationFn: async (patch: Partial<TradingPolicy> & { walletId: string | number }) => {
      const res = await apiRequest("PATCH", "/api/wallet/trading-policy", patch);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.message || "Failed to save");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.setQueryData(policyQueryKey, (prev: TradingPolicy | undefined) => ({ ...prev, ...data }));
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  // Generate Telegram deep-link token
  const telegramLinkMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/alpha/telegram-link", {});
      if (!res.ok) throw new Error("Failed to generate link");
      return res.json() as Promise<{ ok: boolean; deepLink: string }>;
    },
    onSuccess: (data) => {
      setDeepLink(data.deepLink);
    },
    onError: () => {
      toast({ title: "Error", description: "Could not generate Telegram link.", variant: "destructive" });
    },
  });

  // null = no filter active (all groups pass through — backend default)
  // []   = all explicitly disabled
  // [ids] = only these groups pass
  const storedPresetIds: string[] | null = policy?.alphaEnabledPresetGroupIds ?? null;
  const storedPrivateIds: string[] | null = policy?.alphaEnabledPrivateGroupIds ?? null;

  const allPresetIds = (presetData?.groups ?? []).map((g) => g.id);
  const allPrivateIds = (privateData?.groups ?? []).map((g) => g.id);

  // null = all-pass → show as ON; [] = all-off; [ids] = only listed ones are ON
  const isPresetOn = (id: string) => storedPresetIds === null || storedPresetIds.includes(id);
  const isPrivateOn = (id: string) => storedPrivateIds === null || storedPrivateIds.includes(id);

  const togglePresetGroup = useCallback(
    (groupId: string, enabled: boolean) => {
      if (!walletId || !policy) return;
      let next: string[] | null;
      if (enabled) {
        // Adding a group: start from current explicit list (or empty if currently all-off)
        const base = storedPresetIds ?? [];
        const candidate = Array.from(new Set([...base, groupId]));
        // If all known groups are now on, collapse back to null (all-pass)
        next = allPresetIds.length > 0 && allPresetIds.every((id) => candidate.includes(id)) ? null : candidate;
      } else {
        // Removing a group: start from full list if currently all-pass (null), else from stored list
        const base = storedPresetIds === null ? allPresetIds : storedPresetIds;
        next = base.filter((id) => id !== groupId); // [] is valid — means none enabled
      }
      savePolicyMutation.mutate({ walletId, alphaEnabledPresetGroupIds: next });
    },
    [walletId, policy, storedPresetIds, allPresetIds, savePolicyMutation],
  );

  const togglePrivateGroup = useCallback(
    (groupId: string, enabled: boolean) => {
      if (!walletId || !policy) return;
      let next: string[] | null;
      if (enabled) {
        const base = storedPrivateIds ?? [];
        const candidate = Array.from(new Set([...base, groupId]));
        next = allPrivateIds.length > 0 && allPrivateIds.every((id) => candidate.includes(id)) ? null : candidate;
      } else {
        const base = storedPrivateIds === null ? allPrivateIds : storedPrivateIds;
        next = base.filter((id) => id !== groupId);
      }
      savePolicyMutation.mutate({ walletId, alphaEnabledPrivateGroupIds: next });
    },
    [walletId, policy, storedPrivateIds, allPrivateIds, savePolicyMutation],
  );

  const activeFilterDraft = filterDraft ?? policy?.alphaFilters ?? {};

  const saveFilters = () => {
    if (!walletId || filterDraft == null) return;
    savePolicyMutation.mutate(
      { walletId, alphaFilters: filterDraft },
      {
        onSuccess: () => {
          setFilterDraft(null);
          toast({ title: "Alpha filters saved" });
        },
      },
    );
  };

  const hasFilterChanges = filterDraft != null;

  if (!walletId) {
    return (
      <div className="px-4 py-4 sm:px-6 sm:py-6">
        <EmptyState
          icon={Wallet}
          title="No wallet found"
          description="Create a wallet first to configure alpha sources and signal filters."
          className="max-w-xl"
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      {/* Header */}
      <div className="space-y-1">
        <h1
          className="text-2xl font-semibold flex items-center gap-2"
          data-testid="text-alpha-title"
        >
          <Waveform className="w-5 h-5 text-foreground" />
          Alpha sources
        </h1>
        <p className="text-sm text-muted-foreground">
          Manage which alpha groups feed your agent and filter signals by token metrics. Only
          signals from enabled groups are forwarded.
        </p>
      </div>

      {/* Preset groups */}
      <Card data-testid="card-preset-groups">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Preset groups</CardTitle>
          <CardDescription className="text-xs">
            Curated public and premium Telegram groups. Toggle groups on to include their signals.
            All groups are enabled by default — disable individual sources to filter them out.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {presetLoading ? (
            Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)
          ) : !presetData?.groups?.length ? (
            <EmptyState
              icon={Waveform}
              title="No preset groups available"
              description="Public and premium alpha sources will appear here when available."
              compact
              framed={false}
            />
          ) : (
            presetData.groups.map((group) => {
              const isOn = isPresetOn(group.id);
              return (
                <div
                  key={group.id}
                  className="flex flex-col gap-3 rounded-none border border-border/60 bg-muted/20 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                  data-testid={`preset-group-row-${group.id}`}
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium truncate">{group.displayName}</span>
                      {group.isPremium && (
                        <Badge variant="secondary" className="text-[9px] uppercase tracking-wide">
                          Premium
                        </Badge>
                      )}
                      {group.agentTier && (
                        <Badge variant="outline" className="text-[9px] uppercase tracking-wide text-muted-foreground">
                          {group.agentTier}
                        </Badge>
                      )}
                    </div>
                    {group.groupId && (
                      <p className="text-[10px] font-mono text-muted-foreground/70 truncate">
                        id {group.groupId}
                      </p>
                    )}
                  </div>
                  <Switch
                    checked={isOn}
                    onCheckedChange={(checked) => togglePresetGroup(group.id, checked)}
                    disabled={savePolicyMutation.isPending || policyLoading}
                    data-testid={`switch-preset-group-${group.id}`}
                  />
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* Private groups — Telegram-linked */}
      <Card data-testid="card-private-groups">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <MessageCircle className="w-4 h-4 text-foreground" />
            Your Telegram groups
          </CardTitle>
          <CardDescription className="text-xs">
            Private groups from your linked Telegram account. Link your account below to add them.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {privateLoading ? (
            <Skeleton className="h-8 w-full" />
          ) : privateData?.telegramLinked ? (
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs text-profit">
                  <CheckCircle2 className="w-3.5 h-3.5 text-foreground" />
                  Connected{privateData.telegramUsername ? ` as @${privateData.telegramUsername}` : ""}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-muted-foreground"
                  onClick={() => refetchPrivate()}
                  disabled={privateRefetching}
                >
                  {privateRefetching ? "Syncing…" : "↻ Sync"}
                </Button>
              </div>
              {!privateData.groups?.length ? (
                <EmptyState
                  icon={MessageCircle}
                  title="No private groups found"
                  description="Link Telegram and sync recent chats to load your private sources."
                  compact
                  framed={false}
                />
              ) : (
                <div className="space-y-2">
                  {privateData.groups.map((group) => {
                    const isOn = isPrivateOn(group.id);
                    return (
                      <div
                        key={group.id}
                        className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2.5"
                        data-testid={`private-group-row-${group.id}`}
                      >
                        <div className="min-w-0 flex-1">
                          <span className="text-sm font-medium truncate">{group.displayName}</span>
                        </div>
                        <Switch
                          checked={isOn}
                          onCheckedChange={(checked) => togglePrivateGroup(group.id, checked)}
                          disabled={savePolicyMutation.isPending}
                          data-testid={`switch-private-group-${group.id}`}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-muted-foreground pt-1">
                Only groups and channels where your account has recent message history are listed. If a group is missing, send a message there and click <span className="font-medium text-foreground/70">↻ Sync</span>.
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground italic">
              Connect your Telegram account below to add and toggle private groups.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Telegram authentication */}
      <Card data-testid="card-telegram-auth">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            {privateData?.telegramLinked ? (
              <Unlock className="w-4 h-4 text-foreground" />
            ) : (
              <Lock className="w-4 h-4 text-muted-foreground" />
            )}
            Telegram authentication
          </CardTitle>
          <CardDescription className="text-xs">
            Link your Telegram account to enable monitoring of your private groups. A one-time
            secure link is generated for the TraderClaw bot — valid for 15 minutes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!privateData?.telegramLinked ? (
            <>
              {deepLink ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Open the link below in Telegram and follow the bot instructions:
                  </p>
                  <code className="block text-[11px] break-all rounded bg-muted px-2 py-1.5 font-mono">
                    {deepLink}
                  </code>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="gap-1.5" asChild>
                      <a href={deepLink} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="w-3.5 h-3.5" />
                        Open Telegram
                      </a>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => {
                        telegramLinkMutation.mutate();
                        setDeepLink(null);
                      }}
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Refresh link
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    After completing auth in the bot, reload this page to see your groups.
                  </p>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  disabled={telegramLinkMutation.isPending}
                  onClick={() => telegramLinkMutation.mutate()}
                  data-testid="button-generate-telegram-link"
                >
                  <MessageCircle className="w-3.5 h-3.5" />
                  {telegramLinkMutation.isPending ? "Generating…" : "Connect Telegram account"}
                </Button>
              )}
            </>
          ) : (
            <Alert className="border-profit/20 bg-profit/5">
              <CheckCircle2 className="h-4 w-4 text-foreground" />
              <AlertDescription className="text-xs">
                Telegram linked
                {privateData.telegramUsername ? ` as @${privateData.telegramUsername}` : ""}. You
                can reconnect to update the session.
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto p-0 ml-2 text-xs underline-offset-2 hover:underline"
                  onClick={() => {
                    telegramLinkMutation.mutate();
                    setDeepLink(null);
                  }}
                >
                  Reconnect
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {deepLink && privateData?.telegramLinked && (
            <div className="space-y-2">
              <code className="block text-[11px] break-all rounded bg-muted px-2 py-1.5 font-mono">
                {deepLink}
              </code>
              <Button variant="outline" size="sm" className="gap-1.5" asChild>
                <a href={deepLink} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="w-3.5 h-3.5" />
                  Open Telegram to reconnect
                </a>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Separator />

      {/* Alpha signal filters */}
      <Card data-testid="card-alpha-filter">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Filter className="w-4 h-4 text-foreground" />
                Alpha signal filters
              </CardTitle>
              <CardDescription className="text-xs">
                Signals whose token metrics fall outside these bounds are dropped before being
                forwarded to the agent. Reduces LLM noise and cost. Leave a field blank to skip
                that bound.
              </CardDescription>
            </div>
            {hasFilterChanges && (
              <Badge variant="outline" className="text-[10px] text-yellow-400 border-yellow-400/30 shrink-0">
                Unsaved
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {policyLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <>
              <FilterBoundsForm
                bounds={activeFilterDraft}
                disabled={savePolicyMutation.isPending}
                onChange={(b) => setFilterDraft(b)}
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  disabled={!hasFilterChanges || savePolicyMutation.isPending}
                  onClick={saveFilters}
                  data-testid="button-save-alpha-filters"
                >
                  {savePolicyMutation.isPending ? "Saving…" : "Save filters"}
                </Button>
                {hasFilterChanges && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setFilterDraft(null)}
                  >
                    Discard
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Info note when some sources are explicitly disabled */}
      {(storedPresetIds !== null || storedPrivateIds !== null) && (
        <Alert className="border-yellow-500/20 bg-yellow-500/5">
          <Info className="h-4 w-4 text-foreground" />
          <AlertDescription className="text-xs">
            Source filter active — some groups are disabled. Only signals from enabled groups are
            forwarded to the agent. Re-enable all toggles to receive from every monitored source.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
