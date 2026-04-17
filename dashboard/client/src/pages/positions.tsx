import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Copy, TrendingDown, Lock, Unlock, Rows, Receipt, Wallet } from "@/components/ui/icons";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { SolAmount } from "@/components/ui/solana-mark";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Wallet as WalletType, Position } from "@shared/schema";

function formatSol(val: number) {
  return val.toFixed(4);
}

function PnlText({ value }: { value: number }) {
  const color = value > 0 ? "text-profit" : value < 0 ? "text-loss" : "text-muted-foreground";
  const prefix = value > 0 ? "+" : "";
  return (
    <SolAmount
      value={`${prefix}${formatSol(value)}`}
      className="font-mono"
      valueClassName={color}
      markClassName="h-3.5 w-3.5"
    />
  );
}

function PositionRow({ pos, walletId }: { pos: Position & { agentSellBlocked?: boolean }; walletId: string }) {
  const { toast } = useToast();
  const [sellDialogOpen, setSellDialogOpen] = useState(false);
  const [sellPct, setSellPct] = useState(100);

  const pnlPct = pos.entryPrice > 0 ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice * 100) : 0;
  const slLevels = (pos as any)?.slLevels as Array<{ percent: number; amount: number }> | undefined;
  const tpLevelsDetailed = (pos as any)?.tpLevelsDetailed as Array<{ percent: number; amount: number }> | undefined;
  const slLabel = slLevels?.length ? slLevels.map((l) => `${l.percent}% (${l.amount}%)`).join(", ") : (pos.slPct ? `${pos.slPct}%` : "—");
  const tpLabel = tpLevelsDetailed?.length
    ? tpLevelsDetailed.map((l) => `${l.percent}% (${l.amount}%)`).join(", ")
    : (pos.tpLevels ? (pos.tpLevels as number[]).join("%, ") + "%" : "—");

  const agentSellBlocked = Boolean((pos as any).agentSellBlocked);
  const openPositionsKey = ["/api/wallet/positions", `?walletId=${walletId}&status=open`];
  const allPositionsKey = ["/api/wallet/positions", `?walletId=${walletId}`];

  const sellMutation = useMutation({
    mutationFn: async (pct: number) => {
      const res = await apiRequest("POST", "/api/trade/execute", {
        walletId,
        tokenAddress: pos.tokenAddress,
        side: "sell",
        sellPct: pct,
        slippageBps: 300,
        symbol: pos.symbol,
        requestedFrom: "DASHBOARD_REQUEST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.message || `Sell failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      setSellDialogOpen(false);
      toast({ title: `Sell ${sellPct}% submitted`, description: pos.symbol });
      queryClient.invalidateQueries({ queryKey: openPositionsKey });
      queryClient.invalidateQueries({ queryKey: allPositionsKey });
    },
    onError: (err: Error) => {
      toast({ title: "Sell failed", description: err.message, variant: "destructive" });
    },
  });

  const blockMutation = useMutation({
    mutationFn: async (blocked: boolean) => {
      const res = await apiRequest("PATCH", "/api/position/agent-controls", {
        walletId,
        tokenAddress: pos.tokenAddress,
        agentSellBlocked: blocked,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.message || `Update failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: (_data, blocked) => {
      toast({ title: blocked ? "Agent sells blocked" : "Agent sells unblocked", description: pos.symbol });
      queryClient.invalidateQueries({ queryKey: openPositionsKey });
      queryClient.invalidateQueries({ queryKey: allPositionsKey });
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div data-testid={`card-position-${pos.id}`} className="border border-border rounded-none p-4 hover:bg-muted/20 transition-colors">
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            <span className="font-medium text-sm">{pos.symbol}</span>
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
          <Badge variant={pos.status === "open" ? "success" : "secondary"} className="text-[10px]">
            {pos.status.toUpperCase()}
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            {pos.managementMode === "SERVER_MANAGED" ? "Server Managed" : "Local Managed"}
          </Badge>
          {agentSellBlocked && (
            <Badge variant="destructive" className="text-[10px] gap-1">
              <Lock className="w-2.5 h-2.5" />
              Agent sells blocked
            </Badge>
          )}
        </div>
        <PnlText value={pos.unrealizedPnl} />
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-4 lg:grid-cols-6">
        <div>
          <span className="text-muted-foreground block">Side</span>
          <span className="font-medium capitalize">{pos.side}</span>
        </div>
        <div>
          <span className="text-muted-foreground block">Size</span>
          <SolAmount value={formatSol(pos.sizeSol)} className="font-mono" markClassName="h-3.5 w-3.5" />
        </div>
        <div>
          <span className="text-muted-foreground block">Entry</span>
          <span className="font-mono">{pos.entryPrice.toPrecision(4)}</span>
        </div>
        <div>
          <span className="text-muted-foreground block">Current</span>
          <span className="font-mono">{pos.currentPrice.toPrecision(4)}</span>
        </div>
        <div>
          <span className="text-muted-foreground block">PnL %</span>
          <span className={`font-mono ${pnlPct > 0 ? "text-profit" : pnlPct < 0 ? "text-loss" : "text-muted-foreground"}`}>
            {pnlPct > 0 ? "+" : ""}{pnlPct.toFixed(2)}%
          </span>
        </div>
        <div>
          <span className="text-muted-foreground block">Realized</span>
          <PnlText value={pos.realizedPnl} />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 border-t border-border/50 pt-3 text-xs md:grid-cols-5">
        <div>
          <span className="text-muted-foreground block">Stop Loss</span>
          <span className="font-mono">{slLabel}</span>
        </div>
        <div>
          <span className="text-muted-foreground block">Take Profit</span>
          <span className="font-mono">{tpLabel}</span>
        </div>
        <div>
          <span className="text-muted-foreground block">Trailing Stop</span>
          <span className="font-mono">{pos.trailingStopPct ? `${pos.trailingStopPct}%` : "—"}</span>
        </div>
        <div>
          <span className="text-muted-foreground block">Deadlock</span>
          <span className="font-mono">{pos.deadlockState || "none"}</span>
        </div>
        <div>
          <span className="text-muted-foreground block">Token</span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {pos.tokenAddress
              ? `${pos.tokenAddress.slice(0, 8)}...${pos.tokenAddress.slice(-4)}`
              : "—"}
          </span>
        </div>
      </div>

      {pos.status === "open" && (
        <div className="mt-3 pt-3 border-t border-border/50 flex gap-2 flex-wrap">
          <Button
            size="sm"
            variant="destructive"
            className="gap-1.5 text-xs h-7"
            onClick={() => setSellDialogOpen(true)}
          >
            <TrendingDown className="w-3 h-3" />
            Sell position
          </Button>
          <Button
            size="sm"
            variant={agentSellBlocked ? "secondary" : "outline"}
            className="gap-1.5 text-xs h-7"
            disabled={blockMutation.isPending}
            onClick={() => blockMutation.mutate(!agentSellBlocked)}
          >
            {agentSellBlocked ? (
              <>
                <Unlock className="w-3 h-3" />
                Unblock agent sells
              </>
            ) : (
              <>
                <Lock className="w-3 h-3" />
                Block agent sells
              </>
            )}
          </Button>
        </div>
      )}

      <Dialog open={sellDialogOpen} onOpenChange={setSellDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Sell {pos.symbol}</DialogTitle>
            <DialogDescription>
              Choose how much of your position to sell. This bypasses any agent sell blocks.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Sell amount</span>
              <span className="font-semibold">{sellPct}%</span>
            </div>
            <Slider
              min={1}
              max={100}
              step={1}
              value={[sellPct]}
              onValueChange={([v]) => setSellPct(v)}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>1%</span>
              <span>50%</span>
              <span>100%</span>
            </div>
            <div className="flex gap-2 pt-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setSellDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                className="flex-1"
                disabled={sellMutation.isPending}
                onClick={() => sellMutation.mutate(sellPct)}
              >
                {sellMutation.isPending ? "Selling…" : `Sell ${sellPct}%`}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function Positions() {
  const { data: wallets } = useQuery<WalletType[]>({ queryKey: ["/api/wallets"] });
  const wallet = wallets?.[0];
  const hasWallet = !!wallet?.id;

  const { data: openPositions, isLoading: openLoading } = useQuery<Position[]>({
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

  const { data: allPositions, isLoading: allLoading } = useQuery<Position[]>({
    queryKey: ["/api/wallet/positions", wallet?.id ? `?walletId=${wallet.id}` : ""],
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

  const closedPositions = allPositions?.filter(p => p.status !== "open") ?? [];

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <h1 className="text-2xl font-semibold" data-testid="text-page-title">Positions</h1>

      <Tabs defaultValue="open">
        <TabsList data-testid="tabs-positions" className="overflow-x-auto">
          <TabsTrigger value="open" data-testid="tab-open">
            <span>Open</span>
            <span className="tab-trigger-count">{openPositions?.length ?? 0}</span>
          </TabsTrigger>
          <TabsTrigger value="closed" data-testid="tab-closed">
            <span>Closed</span>
            <span className="tab-trigger-count">{closedPositions.length}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="open" className="space-y-3 mt-4">
          {!hasWallet ? (
            <Card>
              <CardContent className="p-5">
                <EmptyState
                  icon={Wallet}
                  title="No wallet found"
                  description="Create a wallet first to view active positions."
                  compact
                  framed={false}
                />
              </CardContent>
            </Card>
          ) : openLoading ? (
            ["open-1", "open-2", "open-3"].map((key) => <Skeleton key={key} className="h-32 w-full" />)
          ) : openPositions?.length === 0 ? (
            <Card>
              <CardContent className="p-5">
                <EmptyState
                  icon={Rows}
                  title="No open positions"
                  description="Active trades will appear here once the agent enters a position."
                  compact
                  framed={false}
                />
              </CardContent>
            </Card>
          ) : (
            openPositions?.map(pos => (
              <PositionRow key={pos.id} pos={pos as any} walletId={wallet?.id ?? ""} />
            ))
          )}
        </TabsContent>

        <TabsContent value="closed" className="space-y-3 mt-4">
          {!hasWallet ? (
            <Card>
              <CardContent className="p-5">
                <EmptyState
                  icon={Wallet}
                  title="No wallet found"
                  description="Create a wallet first to review closed positions and exits."
                  compact
                  framed={false}
                />
              </CardContent>
            </Card>
          ) : allLoading ? (
            ["closed-1", "closed-2", "closed-3"].map((key) => <Skeleton key={key} className="h-32 w-full" />)
          ) : closedPositions.length === 0 ? (
            <Card>
              <CardContent className="p-5">
                <EmptyState
                  icon={Receipt}
                  title="No closed positions"
                  description="Completed sells and fully exited positions will show here."
                  compact
                  framed={false}
                />
              </CardContent>
            </Card>
          ) : (
            closedPositions.map(pos => (
              <PositionRow key={pos.id} pos={pos as any} walletId={wallet?.id ?? ""} />
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
