import { useEffect, useState } from 'react';
import { Switch, Route } from "wouter";
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import {
  queryClient,
  refreshUserSession,
  startUserSession,
  provisionDashboardApiKey,
  clearStoredApiKey,
} from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar } from "@/components/app-sidebar";
import { Header } from "@/components/header";
import { RouteMetadata } from "@/components/route-metadata";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import Dashboard from "@/pages/dashboard";
import Positions from "@/pages/positions";
import TradeLog from "@/pages/trade-log";
import RuntimePage from "@/pages/runtime";
import StakingPage from "@/pages/staking";
import ReferralPage from "@/pages/referral";
import SettingsPage from "@/pages/settings";
import WalletSetupPage from '@/pages/wallet-setup';
import AgentLogsPage from "@/pages/agent-logs";
import AlphaPage from "@/pages/alpha";
import StorePage from "@/pages/store";
import RiskStrategy from "@/pages/risk-strategy";
import BuyStrategy from "@/pages/buy-strategy";
import NotFound from "@/pages/not-found";

type WalletPresence = { id: string };

function Router() {
  const { data: wallets, isLoading } = useQuery<WalletPresence[]>({
    queryKey: ['/api/wallets'],
  });
  // null means 401/unauthenticated — don't treat as "no wallet" to avoid
  // premature redirect before the session bootstrap completes.
  const hasWallet = Array.isArray(wallets) && wallets.length > 0;
  const sessionReady = Array.isArray(wallets); // null = not yet authed
  const [location, setLocation] = useLocation();

  useEffect(() => {
    if (isLoading || !sessionReady) return;
    // Redirect to setup only when there is no wallet and user is not already there.
    // Never auto-redirect AWAY from /wallet-setup — the page handles its own
    // "Continue to Dashboard" navigation so the private key stays visible until
    // the user explicitly dismisses it.
    if (!hasWallet && location !== '/wallet-setup') {
      setLocation('/wallet-setup');
    }
  }, [hasWallet, isLoading, sessionReady, location, setLocation]);

  return (
    <Switch>
      <Route path="/wallet-setup" component={WalletSetupPage} />
      <Route path="/" component={Dashboard} />
      <Route path="/positions" component={Positions} />
      <Route path="/trade-log" component={TradeLog} />
      <Route path="/runtime" component={RuntimePage} />
      <Route path="/staking" component={StakingPage} />
      <Route path="/referral" component={ReferralPage} />
      <Route path="/entitlements" component={RuntimePage} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/alpha" component={AlphaPage} />
      <Route path="/risk-strategy" component={RiskStrategy} />
      <Route path="/buy-strategy" component={BuyStrategy} />
      <Route path="/store" component={StorePage} />
      <Route path="/agent-logs" component={AgentLogsPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    // Best-effort silent session bootstrap — never blocks rendering.
    // Use the Sync button in the header to manually set an API key.
    (async () => {
      try {
        const refreshed = await refreshUserSession();
        if (refreshed) {
          queryClient.invalidateQueries();
          return;
        }
        const apiKey = await provisionDashboardApiKey();
        await startUserSession({ apiKey, clientLabel: 'dashboard-auto' });
        queryClient.invalidateQueries();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // If cached API key is stale (common after dev-session restarts),
        // clear and retry once with a newly provisioned key.
        if (msg.includes('401')) {
          try {
            clearStoredApiKey();
            const freshApiKey = await provisionDashboardApiKey();
            await startUserSession({ apiKey: freshApiKey, clientLabel: 'dashboard-auto-retry' });
            queryClient.invalidateQueries();
            return;
          } catch {
            // fall through to silent mode
          }
        }
        // Silent — dashboard still loads, Sync button available
      }
    })();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouteMetadata />
        <div className="flex h-[100svh] overflow-hidden bg-background text-foreground">
          <div className="hidden md:flex">
            <AppSidebar />
          </div>

          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <SheetContent
              side="left"
              className="w-[18.75rem] max-w-[86vw] border-border bg-sidebar p-0 sm:max-w-[20rem] [&>button]:right-3 [&>button]:top-3 [&>button]:h-10 [&>button]:w-10 [&>button]:rounded-none [&>button]:border [&>button]:border-border/70 [&>button]:bg-sidebar-accent/80 [&>button]:text-sidebar-foreground"
            >
              <AppSidebar mobile onNavigate={() => setMobileNavOpen(false)} />
            </SheetContent>
          </Sheet>

          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <Header onOpenMobileNav={() => setMobileNavOpen(true)} />
            <main className="flex-1 overflow-auto overscroll-contain bg-background">
              <Router />
            </main>
          </div>
        </div>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
