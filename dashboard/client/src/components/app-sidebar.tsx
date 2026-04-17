import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import {
  ArrowUpRight,
  BookOpen,
  CaretDoubleLeft,
  CaretDoubleRight,
  ChartLineUp,
  Clock,
  Gauge,
  Gift,
  Link2,
  Lock,
  Notebook,
  Receipt,
  Settings,
  ShieldCheckered,
  SlidersHorizontal,
  Storefront,
  Wallet,
  Waveform,
} from "@/components/ui/icons";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SyncSessionDialog } from "@/components/sync-session-dialog";
import { useWebSocket } from "@/hooks/use-websocket";
import { dashboardSocketFeatureEnabled } from "@/lib/feature-flags";
import { cn } from "@/lib/utils";
import type { StrategyState, Wallet as WalletType } from "@shared/schema";

const dashboardNav = { path: "/", label: "Dashboard", icon: Gauge };
const tradingNav = [
  { path: "/positions", label: "Positions", icon: ChartLineUp },
  { path: "/trade-log", label: "Trade Log", icon: Receipt },
];
const signalsNav = [{ path: "/alpha", label: "Alpha", icon: Waveform }];
const strategyNav = [
  { path: "/risk-strategy", label: "Risk Strategy", icon: ShieldCheckered },
  { path: "/buy-strategy", label: "Buy Strategy", icon: SlidersHorizontal },
];
const accessNav = [
  { path: "/runtime", label: "Runtime", icon: Clock },
  { path: "/staking", label: "Staking", icon: Lock },
  { path: "/referral", label: "Referral", icon: Gift },
  { path: "/store", label: "Store", icon: Storefront },
];
const agentLogsNav = { path: "/agent-logs", label: "Agent logs", icon: Notebook };
const docsNav = { href: "https://docs.traderclaw.ai", label: "Docs", icon: BookOpen, external: true };
const SIDEBAR_STATE_KEY = "traderclaw.sidebar.collapsed";

function SectionLabel({ children }: { children: string }) {
  return (
    <div
      className="px-3 pb-1.5 text-[10px] tracking-[0.26em] uppercase text-muted-foreground/80"
      style={{ fontFamily: "var(--font-mono)" }}
    >
      {children}
    </div>
  );
}

type AppSidebarProps = {
  mobile?: boolean;
  onNavigate?: () => void;
};

export function AppSidebar({ mobile = false, onNavigate }: AppSidebarProps) {
  const [location, setLocation] = useLocation();
  const { connected } = useWebSocket();
  const { data: wallets } = useQuery<WalletType[]>({
    queryKey: ["/api/wallets"],
  });
  const wallet = wallets?.[0];
  const { data: strategyState } = useQuery<StrategyState>({
    queryKey: ["/api/strategy/state", wallet?.id ? `?walletId=${wallet.id}` : ""],
    enabled: !!wallet?.id,
  });
  const strategyVersion = strategyState?.strategyVersion ?? "v0.0.0";
  const compactStrategyVersion = (() => {
    const match = strategyVersion.match(/v?\d+/i)?.[0];
    if (!match) return strategyVersion;
    return match.toLowerCase().startsWith("v") ? `v${match.slice(1)}` : `v${match}`;
  })();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (mobile || typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(SIDEBAR_STATE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const navSections = [
    { items: [dashboardNav] },
    { title: "Trading", items: tradingNav },
    { title: "Signals", items: signalsNav },
    { title: "Strategy", items: strategyNav },
    { title: "Access", items: accessNav },
    ...(dashboardSocketFeatureEnabled() ? [{ title: "Monitoring", items: [agentLogsNav] }] : []),
    { title: "Resources", items: [docsNav] },
  ];
  const walletActive = location.startsWith("/wallet-setup");
  const settingsActive = location.startsWith("/settings");
  const isCollapsed = mobile ? false : collapsed;
  const handleNavigate = (path: string) => {
    setLocation(path);
    onNavigate?.();
  };

  useEffect(() => {
    if (mobile) return;
    try {
      window.localStorage.setItem(SIDEBAR_STATE_KEY, String(collapsed));
    } catch {
      // no-op if storage is unavailable
    }
  }, [collapsed, mobile]);

  return (
    <aside
      data-testid="sidebar"
      className={cn(
        "bg-sidebar flex flex-col shrink-0 overflow-hidden transition-[width] duration-300 ease-out",
        mobile ? "h-full w-full" : "h-[100svh]",
        mobile ? "w-full" : isCollapsed ? "w-[5.5rem]" : "w-60"
      )}
      style={mobile ? undefined : { borderRight: "1px solid hsl(var(--border))" }}
    >
      {/* Brand header */}
      <div
        className={cn(
          "min-h-16 py-3 flex items-center transition-[padding] duration-300 ease-out",
          isCollapsed ? "justify-center px-3" : "justify-start px-3"
        )}
        style={{ borderBottom: "1px solid hsl(var(--border))" }}
      >
        <div className={cn(isCollapsed ? "" : "w-full")}>
          <Link href="/">
            <div
              className={cn(
                "flex items-center cursor-pointer",
                isCollapsed ? "justify-center" : "w-full justify-start"
              )}
              onClick={() => onNavigate?.()}
            >
              <img
                src={isCollapsed ? "/traderclaw-logo-icon.svg" : "/traderclaw-logo.svg"}
                alt="TraderClaw"
                className={cn(
                  "object-contain shrink-0 select-none transition-all duration-300 ease-out",
                  isCollapsed ? "h-9 w-9" : "block h-auto w-full max-w-none"
                )}
              />
            </div>
          </Link>
        </div>
      </div>

      {/* Nav items */}
      <ScrollArea
        className="min-h-0 flex-1"
        viewportClassName="h-full"
        hideScrollbar
      >
        <nav className={cn("px-3", isCollapsed ? "space-y-3 py-4" : "space-y-4 py-4")}>
          {navSections.map((section, sectionIndex) => (
            <div
              key={section.title ?? section.items.map((item) => item.path).join("-")}
              className={cn(sectionIndex > 0 && isCollapsed ? "border-t border-border/60 pt-3" : "")}
            >
              {!isCollapsed && section.title ? <SectionLabel>{section.title}</SectionLabel> : null}
              <div className={cn("space-y-1", !isCollapsed && !section.title ? "space-y-0" : "")}>
                {section.items.map(({ path, href, label, icon: Icon, external }) => {
                  const isActive = !external && path ? (path === "/" ? location === "/" : location.startsWith(path)) : false;
                  const itemKey = path ?? href ?? label;
                  const buttonClasses = cn(
                    "group/sidebar-nav sidebar-nav-item flex select-none items-center rounded-none cursor-pointer transition-[background-color,color,outline-color] duration-150 focus-visible:outline-none active:bg-primary/10 active:text-foreground",
                    isCollapsed
                      ? "mx-auto h-11 w-11 justify-center px-0 normal-case"
                      : "w-full gap-3 px-3 py-2.5 text-[0.96rem] font-medium tracking-[0.02em] normal-case",
                    isActive
                      ? "nav-active font-medium"
                      : "text-muted-foreground hover:bg-primary/6 hover:text-foreground"
                  );
                  const buttonContents = (
                    <>
                      <Icon
                      className={cn(
                        "shrink-0 transition-all duration-200",
                        isCollapsed ? "h-5 w-5" : "h-[1.05rem] w-[1.05rem]",
                        isActive ? "text-primary" : "text-muted-foreground group-hover/sidebar-nav:text-primary group-active/sidebar-nav:text-primary"
                      )}
                    />
                      {!isCollapsed ? (
                        <>
                          <span className="truncate">{label}</span>
                          {external ? <ArrowUpRight className="ml-auto h-3.5 w-3.5 text-muted-foreground/80 transition-colors duration-150 group-hover/sidebar-nav:text-primary/80 group-active/sidebar-nav:text-primary/80" /> : null}
                        </>
                      ) : null}
                    </>
                  );
                  const navButton = external ? (
                    <a
                      key={itemKey}
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      title={isCollapsed ? label : undefined}
                      aria-label={label}
                      data-testid={`nav-${label.toLowerCase().replace(/\s/g, "-")}`}
                      className={cn(
                        buttonClasses,
                        "no-underline"
                      )}
                      style={
                        isCollapsed
                          ? { WebkitTapHighlightColor: "transparent" }
                          : { fontFamily: "var(--font-sans)", WebkitTapHighlightColor: "transparent" }
                      }
                      onClick={() => onNavigate?.()}
                    >
                      {buttonContents}
                    </a>
                  ) : (
                    <button
                      key={itemKey}
                      type="button"
                      onClick={() => path && handleNavigate(path)}
                      title={isCollapsed ? label : undefined}
                      aria-label={label}
                      data-testid={`nav-${label.toLowerCase().replace(/\s/g, "-")}`}
                      className={buttonClasses}
                      style={
                        isCollapsed
                          ? { WebkitTapHighlightColor: "transparent" }
                          : { fontFamily: "var(--font-sans)", WebkitTapHighlightColor: "transparent" }
                      }
                    >
                      {buttonContents}
                    </button>
                  );

                  if (isCollapsed) {
                    return (
                      <Tooltip key={itemKey} delayDuration={80}>
                        <TooltipTrigger asChild>{navButton}</TooltipTrigger>
                        <TooltipContent
                          side="right"
                          className="text-[11px] uppercase tracking-[0.12em]"
                          style={{ fontFamily: "var(--font-mono)" }}
                        >
                          {label}
                        </TooltipContent>
                      </Tooltip>
                    );
                  }

                  return navButton;
                })}
              </div>
            </div>
          ))}
        </nav>
      </ScrollArea>

      <div className="px-3 py-3">
        <div className={cn(isCollapsed ? "space-y-1 p-2" : "space-y-0 p-0")}>
          <button
            type="button"
            onClick={() => handleNavigate("/wallet-setup")}
            title={isCollapsed ? "Wallet" : undefined}
            data-testid="button-sidebar-wallet"
            className={cn(
              "group flex w-full items-center rounded-none transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
              isCollapsed ? "h-10 justify-center" : "gap-3 border-b border-border/60 px-3 py-3 text-[0.94rem] font-medium tracking-[0.02em]",
              walletActive ? "bg-sidebar-accent/70 text-sidebar-foreground" : "text-muted-foreground"
            )}
            style={isCollapsed ? undefined : { fontFamily: "var(--font-sans)" }}
          >
            <Wallet className={cn("shrink-0", isCollapsed ? "h-5 w-5" : "h-[1.02rem] w-[1.02rem]")} />
            {!isCollapsed ? <span>Wallet</span> : null}
          </button>

          <SyncSessionDialog>
            <button
              type="button"
              title={isCollapsed ? "Sync" : undefined}
              data-testid="button-sidebar-sync"
              className={cn(
                "group flex w-full items-center rounded-none text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                isCollapsed ? "h-10 justify-center" : "gap-3 border-b border-border/60 px-3 py-3 text-[0.94rem] font-medium tracking-[0.02em]"
              )}
              style={isCollapsed ? undefined : { fontFamily: "var(--font-sans)" }}
            >
              <Link2 className={cn("shrink-0", isCollapsed ? "h-5 w-5" : "h-[1.02rem] w-[1.02rem]")} />
              {!isCollapsed ? <span>Sync</span> : null}
            </button>
          </SyncSessionDialog>

          <button
            type="button"
            onClick={() => handleNavigate("/settings")}
            title={isCollapsed ? "Settings" : undefined}
            data-testid="button-sidebar-settings"
            className={cn(
              "group flex w-full items-center rounded-none transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
              isCollapsed ? "h-10 justify-center" : "gap-3 px-3 py-3 text-[0.94rem] font-medium tracking-[0.02em]",
              settingsActive ? "bg-sidebar-accent/70 text-sidebar-foreground" : "text-muted-foreground"
            )}
            style={isCollapsed ? undefined : { fontFamily: "var(--font-sans)" }}
          >
            <Settings className={cn("shrink-0", isCollapsed ? "h-5 w-5" : "h-[1.02rem] w-[1.02rem]")} />
            {!isCollapsed ? <span>Settings</span> : null}
          </button>
        </div>
      </div>

      <div
        className="space-y-3 px-3 py-3"
        style={{ borderTop: "1px solid hsl(var(--border))" }}
      >
        {isCollapsed ? (
          <div className="space-y-2">
            <Tooltip delayDuration={80}>
              <TooltipTrigger asChild>
                <div
                  className="mx-auto flex h-12 w-12 flex-col items-center justify-center gap-1 bg-sidebar-accent/20"
                  aria-label={connected ? "System online" : "System offline"}
                >
                  <span
                    className="block h-2 w-2 shrink-0"
                    style={{ background: connected ? "hsl(var(--profit))" : "hsl(var(--loss))" }}
                  />
                  <span
                    className="text-[8px] leading-none tracking-[0.08em]"
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: connected ? "hsl(var(--profit))" : "hsl(var(--loss))",
                    }}
                  >
                    {connected ? "ON" : "OFF"}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                className="text-[11px] tracking-[0.04em]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {connected ? "System Online" : "System Offline"}
              </TooltipContent>
            </Tooltip>

            <Tooltip delayDuration={80}>
              <TooltipTrigger asChild>
                <div
                  className="mx-auto flex h-12 w-12 items-center justify-center bg-sidebar-accent/20"
                  aria-label={`Version ${strategyVersion}`}
                >
                  <span
                    className="text-[10px] leading-none tracking-[0.04em]"
                    style={{ fontFamily: "var(--font-mono)", color: "hsl(var(--primary))" }}
                  >
                    {compactStrategyVersion}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                className="text-[11px] tracking-[0.04em]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {strategyVersion}
              </TooltipContent>
            </Tooltip>
          </div>
        ) : (
          <div className="px-0 py-0">
            <div className="flex items-center justify-between gap-3 px-3">
              <span
                className="text-[10px] tracking-widest uppercase"
                style={{ fontFamily: "var(--font-mono)", color: "hsl(var(--muted-foreground))" }}
              >
                Sys Status
              </span>
              <span
                className="inline-flex items-center gap-2 text-[10px] leading-[1] tracking-wider"
                style={{
                  fontFamily: "var(--font-mono)",
                  color: connected ? "hsl(var(--profit))" : "hsl(var(--loss))",
                }}
              >
                <span
                  className="block h-2 w-2 shrink-0 self-center"
                  style={{ background: connected ? "hsl(var(--profit))" : "hsl(var(--loss))" }}
                />
                <span>{connected ? "ONLINE" : "OFFLINE"}</span>
              </span>
            </div>
            <div
              className="mt-2 flex items-center justify-between gap-3 border-t border-border/70 px-3 pt-2"
            >
              <span
                className="text-[10px] tracking-widest uppercase"
                style={{ fontFamily: "var(--font-mono)", color: "hsl(var(--muted-foreground))" }}
              >
                Version
              </span>
              <span
                className="text-[10px] leading-[1] tracking-wider"
                style={{ fontFamily: "var(--font-mono)", color: "hsl(var(--primary))" }}
              >
                {strategyVersion}
              </span>
            </div>
          </div>
        )}
        {!mobile ? (
          collapsed ? (
            <button
              type="button"
              data-testid="button-sidebar-toggle"
              onClick={() => setCollapsed((value) => !value)}
              aria-label="Expand sidebar"
              title="Expand sidebar"
              className="mx-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-none border border-border/70 bg-sidebar-accent/40 p-0 text-sidebar-foreground transition-[background-color,border-color,color] duration-200 hover:bg-sidebar-accent hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
            >
              <CaretDoubleRight className="h-4 w-4 shrink-0" />
            </button>
          ) : (
            <button
              type="button"
              data-testid="button-sidebar-toggle"
              onClick={() => setCollapsed((value) => !value)}
              aria-label="Collapse sidebar"
              className="group flex w-full shrink-0 items-center justify-between rounded-none border border-border/70 bg-sidebar-accent/40 px-3 py-2.5 text-sidebar-foreground transition-[background-color,border-color,color] duration-200 hover:bg-sidebar-accent hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
            >
              <span
                className="text-[11px] uppercase tracking-[0.08em]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                Collapse
              </span>
              <CaretDoubleLeft className="h-4 w-4 shrink-0" />
            </button>
          )
        ) : null}
      </div>
    </aside>
  );
}
