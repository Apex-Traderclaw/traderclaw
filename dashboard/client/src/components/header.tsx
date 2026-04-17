import { useQuery } from "@tanstack/react-query";
import { Link2, PanelLeftIcon, Power, Radio, WifiOff, Wallet } from "@/components/ui/icons";
import { useLocation } from "wouter";
import { useWebSocket } from "@/hooks/use-websocket";
import { isAdminSession } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { SolAmount } from "@/components/ui/solana-mark";
import { SyncSessionDialog } from "@/components/sync-session-dialog";
import { cn } from "@/lib/utils";
import type { Wallet as WalletType, KillSwitch } from "@shared/schema";

const HEADER_CHIP_CLASS =
  "inline-flex h-9 items-center gap-2 border px-3 text-[11px] font-medium uppercase tracking-[0.16em] rounded-none";
const HEADER_ICON_CLASS = "h-3.5 w-3.5 shrink-0";
const HEADER_LABEL_STYLE = { fontFamily: "var(--font-mono)" };
const MOBILE_ACTION_BUTTON_CLASS =
  "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-none border text-foreground transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.98] active:bg-muted/35";
const MOBILE_ACTION_ICON_CLASS = "h-[1.1rem] w-[1.1rem] shrink-0";

type HeaderProps = {
  onOpenMobileNav?: () => void;
};

export function Header({ onOpenMobileNav }: HeaderProps) {
  const { connected } = useWebSocket();
  const [, setLocation] = useLocation();
  const isAdmin = isAdminSession();

  const { data: wallets } = useQuery<WalletType[]>({
    queryKey: ["/api/wallets"],
  });

  const wallet = wallets?.[0];

  const { data: killSwitch } = useQuery<KillSwitch>({
    queryKey: ["/api/killswitch/status", wallet?.id ? `?walletId=${wallet.id}` : ""],
    enabled: !!wallet?.id,
  });

  const balanceSol = wallet ? wallet.balanceLamports / 1e9 : 0;
  const killSwitchLabel = killSwitch?.enabled
    ? `Kill ${String(killSwitch.mode || "trades only").toLowerCase().replace(/_/g, " ")}`
    : "Kill disabled";
  const connectionMobileLabel = connected ? "System online" : "System offline";
  const killSwitchMobileLabel = killSwitch?.enabled ? "Kill switch enabled" : "Kill switch disabled";

  return (
    <header
      data-testid="header"
      className="sticky top-0 z-30 bg-card/95 backdrop-blur-sm"
      style={{ borderBottom: "1px solid hsl(var(--border))" }}
    >
      <div className="md:hidden flex min-h-16 items-center justify-between gap-2 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setLocation("/")}
            title="Open dashboard"
            aria-label="Open dashboard"
            data-testid="button-mobile-dashboard-home"
            className={cn(
              MOBILE_ACTION_BUTTON_CLASS,
              "border-border/80 bg-transparent hover:border-border hover:bg-muted/25"
            )}
            style={{ WebkitTapHighlightColor: "transparent" }}
          >
            <img
              src="/traderclaw-logo-icon.svg"
              alt="TraderClaw"
              className="h-5 w-5 object-contain"
            />
          </button>

          <button
            type="button"
            data-testid="status-balance-mobile"
            title="Open wallet settings"
            aria-label="Open wallet settings"
            onClick={() => setLocation("/settings")}
            className={cn(
              MOBILE_ACTION_BUTTON_CLASS,
              "border-primary bg-primary text-primary-foreground hover:bg-primary/92"
            )}
            style={{ WebkitTapHighlightColor: "transparent" }}
          >
            <Wallet className={`${MOBILE_ACTION_ICON_CLASS} text-primary-foreground`} />
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <SyncSessionDialog>
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-10 w-10 rounded-none border-border/80 bg-transparent text-foreground hover:border-border hover:bg-muted/25"
              data-testid="button-sync-session-mobile"
              title="Sync session"
              aria-label="Sync session"
              style={HEADER_LABEL_STYLE}
            >
              <Link2 className={MOBILE_ACTION_ICON_CLASS} />
            </Button>
          </SyncSessionDialog>

          <button
            type="button"
            data-testid="status-connection-mobile"
            title={connectionMobileLabel}
            aria-label={connectionMobileLabel}
            onClick={() => setLocation("/agent-logs")}
            className={cn(
              MOBILE_ACTION_BUTTON_CLASS,
              connected
                ? "border-profit/25 bg-profit/10 text-profit hover:border-profit/40 hover:bg-profit/15"
                : "border-loss/25 bg-loss/10 text-loss hover:border-loss/40 hover:bg-loss/15"
            )}
            style={{ WebkitTapHighlightColor: "transparent" }}
          >
            {connected ? (
              <Radio className={MOBILE_ACTION_ICON_CLASS} />
            ) : (
              <WifiOff className={MOBILE_ACTION_ICON_CLASS} />
            )}
          </button>

          {killSwitch ? (
            <button
              type="button"
              data-testid="status-killswitch-mobile"
              title={killSwitchMobileLabel}
              aria-label={killSwitchMobileLabel}
              onClick={() => setLocation("/")}
              className={cn(
                MOBILE_ACTION_BUTTON_CLASS,
                killSwitch.enabled
                  ? "border-loss/25 bg-loss/10 text-loss hover:border-loss/40 hover:bg-loss/15"
                  : "border-border/80 bg-muted/15 text-muted-foreground hover:border-border hover:bg-muted/25 hover:text-foreground"
              )}
              style={{ WebkitTapHighlightColor: "transparent" }}
            >
              <Power className={MOBILE_ACTION_ICON_CLASS} />
            </button>
          ) : null}

          <Button
            type="button"
            size="icon"
            variant="outline"
            className="h-10 w-10 rounded-none border-border/80 bg-transparent text-foreground hover:border-border hover:bg-muted/25"
            onClick={onOpenMobileNav}
            data-testid="button-open-mobile-nav"
            title="Open menu"
            aria-label="Open menu"
            style={HEADER_LABEL_STYLE}
          >
            <PanelLeftIcon className={MOBILE_ACTION_ICON_CLASS} />
          </Button>
        </div>
      </div>

      <div className="hidden min-h-16 items-center gap-3 px-3 sm:px-4 md:flex">
        <div className="ml-auto flex min-w-0 flex-1 justify-end overflow-x-auto">
          <div className="flex min-w-max items-center gap-2 py-2.5">
        {/* Connection status */}
        <div
          data-testid="status-connection"
          className={`${HEADER_CHIP_CLASS} ${
            connected
              ? "border-profit/25 bg-profit/10 text-profit"
              : "border-loss/25 bg-loss/10 text-loss"
          }`}
          style={HEADER_LABEL_STYLE}
        >
          {connected ? (
            <>
              <span className="live-dot shrink-0" />
              <span>Online</span>
            </>
          ) : (
            <>
              <WifiOff className={`${HEADER_ICON_CLASS} text-loss`} />
              <span>Offline</span>
            </>
          )}
        </div>

        {isAdmin ? (
          <div
            data-testid="status-admin-mode"
            className={`${HEADER_CHIP_CLASS} border-border/80 bg-muted/15 text-foreground`}
            style={HEADER_LABEL_STYLE}
          >
            Admin
          </div>
        ) : null}

        {/* Kill switch badge */}
        {killSwitch && (
          <div
            data-testid="status-killswitch"
            className={`${HEADER_CHIP_CLASS} ${
              killSwitch.enabled
                ? "border-loss/25 bg-loss/10 text-loss"
                : "border-border/80 bg-muted/15 text-muted-foreground"
            }`}
            style={HEADER_LABEL_STYLE}
          >
            <Power className={`${HEADER_ICON_CLASS} ${killSwitch.enabled ? "text-loss" : "text-muted-foreground"}`} />
            {killSwitchLabel}
          </div>
        )}

        {/* Sync session dialog */}
        <SyncSessionDialog>
          <Button
            size="sm"
            variant="outline"
            className={`${HEADER_CHIP_CLASS} border-border/80 bg-transparent text-foreground hover:border-border hover:bg-muted/25`}
            data-testid="button-sync-session"
            style={HEADER_LABEL_STYLE}
          >
            <Link2 className={HEADER_ICON_CLASS} />
            Sync
          </Button>
        </SyncSessionDialog>

        {/* Balance */}
        <button
          type="button"
          data-testid="status-balance"
          title="View wallet settings"
          onClick={() => setLocation("/settings")}
          className={`${HEADER_CHIP_CLASS} cursor-pointer border-primary bg-primary text-primary-foreground transition-colors hover:bg-primary/92`}
          style={HEADER_LABEL_STYLE}
        >
          <Wallet className={`${HEADER_ICON_CLASS} text-primary-foreground`} />
          <SolAmount
            value={balanceSol.toFixed(4)}
            className="text-sm font-bold tabular-nums"
            valueClassName="font-mono text-primary-foreground"
            markClassName="h-[0.95em] w-[0.95em]"
            iconClassName="text-primary-foreground"
          />
        </button>
          </div>
        </div>
      </div>
    </header>
  );
}
