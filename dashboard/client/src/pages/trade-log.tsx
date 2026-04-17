import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Brain, Receipt, ShieldOff, ShoppingBag, ShoppingCart, Wallet, Waveform } from "@/components/ui/icons";
import { apiRequest } from "@/lib/queryClient";
import type { Wallet as WalletType, RiskDenial } from "@shared/schema";

const MONO_FONT = { fontFamily: "var(--font-mono)" };
const BODY_FONT = { fontFamily: "var(--font-sans)" };

type OpenClawTrade = {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  sizeSol: number;
  priceUsd?: number;
  price?: number;
  feesSol: number;
  pnlSol?: number | null;
  status: string;
  createdAt: string;
};

function formatSol(val: number) {
  return val.toFixed(4);
}

function timeAgo(date: string | Date) {
  const d = new Date(date);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const tradeSkeletonKeys = ["trade-skeleton-1", "trade-skeleton-2", "trade-skeleton-3", "trade-skeleton-4", "trade-skeleton-5"];
const denialSkeletonKeys = ["denial-skeleton-1", "denial-skeleton-2", "denial-skeleton-3"];

function TradeLogStatCard({
  pretitle,
  title,
  value,
  icon: Icon,
}: {
  pretitle: string;
  title: string;
  value: number;
  icon: any;
}) {
  return (
    <Card className="border-0 card-glow">
      <CardContent className="p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <span
            className="text-xs tracking-[0.12em] uppercase"
            style={{ ...MONO_FONT, color: "hsl(var(--muted-foreground))" }}
          >
            {pretitle}
          </span>
          <span className="inline-flex h-9 w-9 items-center justify-center text-foreground transition-colors duration-200 group-hover/card:text-primary">
            <Icon className="h-[1.05rem] w-[1.05rem]" />
          </span>
        </div>

        <div className="text-2xl font-bold tabular-nums" style={{ ...MONO_FONT, color: "hsl(var(--foreground))" }}>
          {value}
        </div>
        <div className="mt-1 text-sm text-foreground" style={BODY_FONT}>{title}</div>
      </CardContent>
    </Card>
  );
}

export default function TradeLog() {
  const { data: wallets } = useQuery<WalletType[]>({ queryKey: ["/api/wallets"] });
  const wallet = wallets?.[0];
  const hasWallet = !!wallet?.id;

  const { data: tradesData, isLoading: tradesLoading } = useQuery<{ trades: OpenClawTrade[]; total: number }>({
    queryKey: ["/api/trades", wallet?.id ? `?walletId=${wallet.id}&limit=50` : ""],
    enabled: !!wallet?.id,
  });

  const { data: denials, isLoading: denialsLoading } = useQuery<RiskDenial[]>({
    queryKey: ["/api/risk-denials", wallet?.id ? `?walletId=${wallet.id}` : ""],
    enabled: !!wallet?.id,
    queryFn: async ({ queryKey }) => {
      const [, search] = queryKey as [string, string];
      const res = await apiRequest("GET", `/api/risk-denials${search || ""}`);
      const payload = await res.json();
      if (Array.isArray(payload)) return payload;
      if (Array.isArray(payload?.denials)) return payload.denials;
      return [];
    },
  });

  const tradeRows = tradesData?.trades ?? [];
  const totalTrades = tradesData?.total ?? tradeRows.length;
  const totalDenials = denials?.length ?? 0;
  const totalSignals = totalTrades + totalDenials;
  const totalDeepAnalysis = totalDenials;
  const totalBuys = tradeRows.filter((trade) => trade.side === "buy").length;
  const totalSells = tradeRows.filter((trade) => trade.side === "sell").length;

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold" data-testid="text-page-title">Trade Log</h1>
      </div>

      {(tradesLoading || denialsLoading) ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {["trade-log-stat-1", "trade-log-stat-2", "trade-log-stat-3", "trade-log-stat-4", "trade-log-stat-5"].map((key) => (
            <Skeleton key={key} className="h-32 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <TradeLogStatCard
            pretitle="Signal Feed"
            title="Total Signals"
            value={totalSignals}
            icon={Waveform}
          />
          <TradeLogStatCard
            pretitle="Review Layer"
            title="Total Deep Analysis"
            value={totalDeepAnalysis}
            icon={Brain}
          />
          <TradeLogStatCard
            pretitle="Execution"
            title="Total Buys"
            value={totalBuys}
            icon={ShoppingCart}
          />
          <TradeLogStatCard
            pretitle="Execution"
            title="Total Sells"
            value={totalSells}
            icon={ShoppingBag}
          />
          <TradeLogStatCard
            pretitle="Trade Log"
            title="Total Trades"
            value={totalTrades}
            icon={Receipt}
          />
        </div>
      )}

      <Tabs defaultValue="trades">
        <TabsList data-testid="tabs-trade-log" className="overflow-x-auto">
          <TabsTrigger value="trades" data-testid="tab-trades">
            <span>Trades</span>
            <span className="tab-trigger-count">{tradesData?.total ?? 0}</span>
          </TabsTrigger>
          <TabsTrigger value="denials" data-testid="tab-denials">
            <span>Risk Denials</span>
            <span className="tab-trigger-count">{denials?.length ?? 0}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="trades" className="mt-4">
          <Card>
            <CardContent className="p-0">
              {!hasWallet ? (
                <div className="p-5">
                  <EmptyState
                    icon={Wallet}
                    title="No wallet found"
                    description="Create a wallet first to review trade executions and history."
                    compact
                    framed={false}
                  />
                </div>
              ) : tradesLoading ? (
                <div className="p-4 space-y-2">
                  {tradeSkeletonKeys.map((key) => <Skeleton key={key} className="h-10 w-full" />)}
                </div>
              ) : !tradesData?.trades?.length ? (
                <div className="p-5">
                  <EmptyState
                    icon={Receipt}
                    title="No trades yet"
                    description="Executed buys and sells will appear here once the agent starts trading."
                    compact
                    framed={false}
                  />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-muted-foreground border-b border-border">
                        <th className="text-left py-3 px-4">Time</th>
                        <th className="text-left py-3 px-2">Token</th>
                        <th className="text-center py-3 px-2">Side</th>
                        <th className="text-right py-3 px-2">Size</th>
                        <th className="text-right py-3 px-2">Price</th>
                        <th className="text-right py-3 px-2">PnL</th>
                        <th className="text-center py-3 px-4">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tradesData.trades.map((trade) => (
                        <tr key={trade.id} className="border-b border-border/30 hover:bg-muted/20" data-testid={`row-trade-${trade.id}`}>
                          <td className="py-2.5 px-4 text-muted-foreground">{timeAgo(trade.createdAt)}</td>
                          <td className="py-2.5 px-2 font-medium">{trade.symbol}</td>
                          <td className="py-2.5 px-2 text-center">
                            <Badge variant={trade.side === "buy" ? "default" : "secondary"} className="text-[10px]">
                              {trade.side.toUpperCase()}
                            </Badge>
                          </td>
                          <td className="py-2.5 px-2 text-right font-mono">{formatSol(trade.sizeSol)}</td>
                          <td className="py-2.5 px-2 text-right font-mono">
                            {Number(trade.priceUsd ?? trade.price ?? 0).toPrecision(4)}
                          </td>
                          <td className="py-2.5 px-2 text-right">
                            {trade.pnlSol !== null && trade.pnlSol !== undefined ? (
                              <span className={`font-mono ${trade.pnlSol > 0 ? "text-profit" : trade.pnlSol < 0 ? "text-loss" : "text-muted-foreground"}`}>
                                {trade.pnlSol > 0 ? "+" : ""}{formatSol(trade.pnlSol)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="py-2.5 px-4 text-center">
                            <Badge
                              variant={
                                trade.status === "filled" || trade.status === "confirmed"
                                  ? "success"
                                  : trade.status === "failed"
                                    ? "loss"
                                    : "secondary"
                              }
                              className="text-[10px]"
                            >
                              {trade.status}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="denials" className="mt-4 space-y-2">
          {!hasWallet ? (
            <Card>
              <CardContent className="p-5">
                <EmptyState
                  icon={Wallet}
                  title="No wallet found"
                  description="Create a wallet first to review risk denials and skipped opportunities."
                  compact
                  framed={false}
                />
              </CardContent>
            </Card>
          ) : denialsLoading ? (
            denialSkeletonKeys.map((key) => <Skeleton key={key} className="h-16 w-full" />)
          ) : !denials?.length ? (
            <Card>
              <CardContent className="p-5">
                <EmptyState
                  icon={ShieldOff}
                  title="No risk denials"
                  description="Blocked trades and policy denials will show here when they occur."
                  compact
                  framed={false}
                />
              </CardContent>
            </Card>
          ) : (
            denials.map((denial) => (
              <Card key={denial.id} data-testid={`card-denial-${denial.id}`}>
                <CardContent className="py-3 px-4">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <Badge variant={denial.severity === "hard" ? "destructive" : "secondary"} className="text-[10px]">
                        {denial.severity.toUpperCase()}
                      </Badge>
                      <Badge variant="outline" className="text-[10px] font-mono">{denial.ruleCode}</Badge>
                    </div>
                    <span className="text-[10px] text-muted-foreground">{timeAgo(denial.createdAt)}</span>
                  </div>
                  <p className="text-xs text-foreground">{denial.reason}</p>
                  {denial.tokenAddress && (
                    <p className="text-[10px] text-muted-foreground mt-1 font-mono">{denial.tokenAddress.slice(0, 12)}...{denial.tokenAddress.slice(-6)}</p>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
