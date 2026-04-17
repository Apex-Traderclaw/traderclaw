import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/ui/empty-state";
import { Radio, ScrollText } from "@/components/ui/icons";
import { apiRequest } from "@/lib/queryClient";
import { dashboardSocketFeatureEnabled } from "@/lib/feature-flags";
import { subscribeDashboardLogBatches } from "@/lib/dashboard-log-bus";
import { useWebSocket } from "@/hooks/use-websocket";

const MOCK_LOG_LINES = [
  '{"_meta":{"name":"openclaw","logLevelName":"INFO"},"msg":"SKIP AITOKEN — SUPER ALPHA score 55 — confidence 0.00"}',
  '{"msg":"Duplicate signal — same token hard-skipped"}',
];

type ForwardEvent = {
  id: string;
  streamType?: string | null;
  eventName?: string | null;
  status?: string | null;
  reason?: string | null;
  createdAt?: string | null;
  agentId?: string | null;
};

const MAX_LINES = 500;

function useDashboardLiveLines() {
  const [lines, setLines] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    return subscribeDashboardLogBatches((incoming, replay) => {
      if (paused && !replay) return;
      setLines((prev) => {
        const next = replay ? [...incoming] : [...prev, ...incoming];
        if (next.length > MAX_LINES) return next.slice(-MAX_LINES);
        return next;
      });
    });
  }, [paused]);

  const clear = useCallback(() => setLines([]), []);

  return { lines, paused, setPaused, clear };
}

export default function AgentLogsPage() {
  const featureOn = dashboardSocketFeatureEnabled();
  const { connected } = useWebSocket();
  const { lines, paused, setPaused, clear } = useDashboardLiveLines();
  const [filter, setFilter] = useState("");

  const { data: forwardData, isLoading: forwardLoading, error: forwardError } = useQuery({
    queryKey: ["/api/dashboard/agent-forward-events"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/dashboard/agent-forward-events?limit=50");
      return res.json() as Promise<{ ok?: boolean; events?: ForwardEvent[] }>;
    },
    enabled: featureOn,
    retry: false,
  });

  const filteredLines = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return lines;
    return lines.filter((l) => l.toLowerCase().includes(q));
  }, [lines, filter]);

  const mockLines = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return MOCK_LOG_LINES;
    return MOCK_LOG_LINES.filter((l) => l.toLowerCase().includes(q));
  }, [filter]);

  if (!featureOn) {
    return (
      <div className="p-6 max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle>Agent logs</CardTitle>
            <CardDescription>
              This view is disabled. Set{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">VITE_OPENCLAW_DASHBOARD_SOCKET_ENABLED=true</code>{" "}
              at build time and enable{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">OPENCLAW_DASHBOARD_SOCKET_ENABLED</code> on the
              orchestrator.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const forwardEvents = forwardData?.events ?? [];
  const apiDisabled =
    forwardError instanceof Error &&
    (forwardError.message.includes("404") || forwardError.message.includes("DASHBOARD_SOCKET_DISABLED"));

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold" data-testid="text-page-title">
          Agent logs
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={`text-xs font-mono ${connected ? "border-profit/30 text-profit" : "border-loss/30 text-loss"}`}>
            WS {connected ? "connected" : "disconnected"}
          </Badge>
          <Badge variant="secondary" className="text-xs">
            Orchestrator flag required for API + ingest
          </Badge>
        </div>
      </div>

      <Tabs defaultValue="live">
        <TabsList className="overflow-x-auto">
          <TabsTrigger value="live">Live stream</TabsTrigger>
          <TabsTrigger value="forward">Forward audit</TabsTrigger>
          <TabsTrigger value="demo">Demo data</TabsTrigger>
        </TabsList>

        <TabsContent value="live" className="mt-4 space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>
                Raw lines from the log forwarder (plugin) via POST ingest, then WebSocket channel{" "}
                <code className="text-xs">dashboard-logs</code>. Requires session auth on <code className="text-xs">/ws</code>
                .
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <Input
                  placeholder="Filter (forward, response, probe, signal…)"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="w-full max-w-md font-mono text-xs"
                />
                <Button type="button" variant="secondary" size="sm" onClick={() => setPaused(!paused)}>
                  {paused ? "Resume" : "Pause"}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={clear}>
                  Clear
                </Button>
              </div>
              <ScrollArea className="h-[420px] w-full rounded-none border border-border bg-[#0a0a0c] p-3">
                {filteredLines.length === 0 ? (
                  <div className="flex min-h-[392px] items-center justify-center">
                    <EmptyState
                      icon={ScrollText}
                      title="No lines yet"
                      description={
                        <>
                          Enable the orchestrator flag, run the plugin with{" "}
                          <code className="text-primary/90">dashboardSocketEnabled</code>, or open the Demo tab.
                        </>
                      }
                      compact
                      framed={false}
                      className="w-full"
                    />
                  </div>
                ) : (
                  <pre className="text-[11px] leading-relaxed font-mono text-muted-foreground whitespace-pre-wrap break-all">
                    {filteredLines.map((line, i) => (
                      <div key={`${i}-${line.slice(0, 24)}`} className="border-b border-white/5 py-1">
                        {line}
                      </div>
                    ))}
                  </pre>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="forward" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Agent forward events</CardTitle>
              <CardDescription>
                Structured audit from <code className="text-xs">openclaw_agent_forward_events</code>. Returns 404 until{" "}
                <code className="text-xs">OPENCLAW_DASHBOARD_SOCKET_ENABLED</code> is on.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {apiDisabled ? (
                <p className="text-sm text-muted-foreground">
                  API disabled or unreachable (enable orchestrator env flag).
                </p>
              ) : forwardLoading ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : forwardEvents.length === 0 ? (
                <EmptyState
                  icon={Radio}
                  title="No forward events yet"
                  description="Structured agent forward events will appear here once the orchestrator starts emitting them."
                  compact
                  framed={false}
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-muted-foreground border-b border-border text-left">
                        <th className="py-2 pr-2">Time</th>
                        <th className="py-2 pr-2">Stream</th>
                        <th className="py-2 pr-2">Event</th>
                        <th className="py-2 pr-2">Status</th>
                        <th className="py-2 pr-2">Agent</th>
                      </tr>
                    </thead>
                    <tbody>
                      {forwardEvents.map((ev) => (
                        <tr key={ev.id} className="border-b border-border/60">
                          <td className="py-2 pr-2 whitespace-nowrap">{ev.createdAt || "—"}</td>
                          <td className="py-2 pr-2">{ev.streamType || "—"}</td>
                          <td className="py-2 pr-2 font-mono">{ev.eventName || "—"}</td>
                          <td className="py-2 pr-2">{ev.status || "—"}</td>
                          <td className="py-2 pr-2 font-mono truncate max-w-[120px]">{ev.agentId || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="demo" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Mock stream</CardTitle>
              <CardDescription>Static sample lines for layout review (no backend).</CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[320px] w-full rounded-md border border-border bg-[#0a0a0c] p-3">
                <pre className="text-[11px] leading-relaxed font-mono text-muted-foreground whitespace-pre-wrap break-all">
                  {mockLines.map((line, i) => (
                    <div key={i} className="border-b border-white/5 py-1">
                      {line}
                    </div>
                  ))}
                </pre>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
