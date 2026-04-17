import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { ArrowUpRight, Clock, Copy, Gift, Link2, Sparkles } from "@/components/ui/icons";

type ReferralMe = {
  apiKey: string;
  referralCode: string | null;
  referralTier: string;
  referralPercentage: number;
  referredByReferralId: string | null;
  waitlistSyncedAt: string | null;
  referralProgramEnabled: boolean;
  accessUntil: string | null;
  accessSecondsRemaining: number | null;
  stakeTclawAmount: number;
  stakingUrl: string;
};

function formatAccessCountdown(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatStakeTclaw(n: number) {
  if (!Number.isFinite(n) || n <= 0) return "—";
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

export default function ReferralPage() {
  const { toast } = useToast();
  const [referralCodeDraft, setReferralCodeDraft] = useState("");
  const [waitlistEmail, setWaitlistEmail] = useState("");
  const [waitlistTelegramId, setWaitlistTelegramId] = useState("");
  const [accessTick, setAccessTick] = useState(0);

  const { data: referralMe, isLoading: referralLoading } = useQuery<ReferralMe | null>({
    queryKey: ["/api/referral/me"],
  });

  useEffect(() => {
    if (!referralMe?.accessUntil) return;
    const id = window.setInterval(() => setAccessTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [referralMe?.accessUntil]);

  const accessSecondsLive = useMemo(() => {
    if (!referralMe?.accessUntil) return null;
    const ms = new Date(referralMe.accessUntil).getTime() - Date.now();
    return Math.max(0, Math.floor(ms / 1000));
  }, [referralMe?.accessUntil, accessTick]);

  const saveReferralCodeMutation = useMutation({
    mutationFn: async (code: string) => {
      const res = await apiRequest("PUT", "/api/referral/code", {
        referralCode: code.trim().toUpperCase(),
      });
      return res.json() as Promise<{ ok: boolean; referralCode: string }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/referral/me"] });
      toast({ title: "Referral code saved" });
      setReferralCodeDraft("");
    },
    onError: (err: Error) => {
      toast({
        title: "Could not save referral code",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const syncWaitlistMutation = useMutation({
    mutationFn: async () => {
      const body: { email?: string; telegramId?: string } = {};
      if (waitlistEmail.trim()) body.email = waitlistEmail.trim();
      if (waitlistTelegramId.trim()) body.telegramId = waitlistTelegramId.trim();
      const res = await apiRequest("POST", "/api/referral/sync-waitlist", body);
      return res.json() as Promise<{ ok: boolean }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/referral/me"] });
      toast({
        title: "Waitlist referral linked",
        description: "Your fee share path is synced from the waitlist.",
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Sync failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="w-full max-w-4xl space-y-6 xl:max-w-[56rem] 2xl:max-w-[50%]">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold" data-testid="text-page-title">
            Referral
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Manage your referral code, access window, rewards status, and waitlist attribution from one dedicated access surface.
          </p>
        </div>

        {referralLoading ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <Skeleton className="h-48 w-full" />
              <Skeleton className="h-48 w-full" />
            </div>
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <Skeleton className="h-72 w-full" />
              <Skeleton className="h-72 w-full" />
            </div>
          </div>
        ) : referralMe === null ? (
          <Card>
            <CardContent className="p-5">
              <EmptyState
                icon={Link2}
                title="Session disconnected"
                description="Re-sync your API session to manage referral access and code settings."
                compact
                framed={false}
              />
            </CardContent>
          </Card>
        ) : !referralMe ? (
          <Card>
            <CardContent className="p-5">
              <EmptyState
                icon={Gift}
                title="Referral data unavailable"
                description="Referral details could not be loaded for this session right now."
                compact
                framed={false}
              />
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <Card data-testid="card-referral-access-window">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-foreground" />
                    Access window
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {referralMe.accessUntil == null ? (
                    <p className="text-sm text-muted-foreground">
                      No fixed trial end is attached to this key right now.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      <div className="border border-border/70 bg-muted/15 px-3 py-3">
                        <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                          Time remaining
                        </div>
                        <div className="text-lg font-medium" style={{ fontFamily: "var(--font-mono)" }} data-testid="text-access-countdown">
                          {formatAccessCountdown(accessSecondsLive ?? referralMe.accessSecondsRemaining ?? 0)}
                        </div>
                      </div>
                      <div className="flex flex-col gap-1 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                        <span>Ends</span>
                        <span className="font-mono text-xs text-foreground">{new Date(referralMe.accessUntil).toLocaleString()}</span>
                      </div>
                    </div>
                  )}
                  <div className="border border-border/70 bg-muted/10 px-3 py-3">
                    <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                      Extend access
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Stake <span className="font-mono text-foreground">{formatStakeTclaw(referralMe.stakeTclawAmount)} $TCLAW</span> if you need more time on this account.
                    </p>
                    <a
                      href={referralMe.stakingUrl || "https://traderclaw.ai/staking"}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-3 inline-flex items-center gap-1 text-xs uppercase tracking-[0.12em] text-primary underline"
                      style={{ fontFamily: "var(--font-mono)" }}
                      data-testid="link-staking"
                    >
                      Open staking
                      <ArrowUpRight className="h-3.5 w-3.5" />
                    </a>
                  </div>
                </CardContent>
              </Card>

              <Card data-testid="card-referral-program">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-foreground" />
                    Program status
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="border border-border/70 bg-muted/15 px-3 py-3">
                      <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                        Status
                      </div>
                      <Badge variant="outline" className="text-[10px]">
                        {referralMe.referralProgramEnabled ? "Enabled" : "Disabled"}
                      </Badge>
                    </div>
                    <div className="border border-border/70 bg-muted/15 px-3 py-3">
                      <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                        Fee share
                      </div>
                      <div className="text-sm text-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                        {referralMe.referralPercentage}%
                      </div>
                    </div>
                    <div className="border border-border/70 bg-muted/15 px-3 py-3">
                      <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                        Tier
                      </div>
                      <div className="text-sm text-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                        {referralMe.referralTier || "—"}
                      </div>
                    </div>
                    <div className="border border-border/70 bg-muted/15 px-3 py-3">
                      <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                        Waitlist link
                      </div>
                      <div className="text-sm text-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                        {referralMe.waitlistSyncedAt ? "Linked" : "Not linked"}
                      </div>
                    </div>
                  </div>

                  <div className="border border-border/70 bg-muted/10 px-3 py-3">
                    <div className="mb-2 text-[11px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                      Rewards
                    </div>
                    <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                      <div className="flex items-center justify-between gap-2 border border-border/60 bg-muted/20 px-2 py-2">
                        <span className="text-muted-foreground">Lifetime (est.)</span>
                        <span className="font-mono text-foreground">—</span>
                      </div>
                      <div className="flex items-center justify-between gap-2 border border-border/60 bg-muted/20 px-2 py-2">
                        <span className="text-muted-foreground">Pending / claimable</span>
                        <span className="font-mono text-foreground">—</span>
                      </div>
                      <div className="flex items-center justify-between gap-2 border border-border/60 bg-muted/20 px-2 py-2 sm:col-span-2">
                        <span className="text-muted-foreground">Last payout</span>
                        <span className="font-mono text-foreground">—</span>
                      </div>
                    </div>
                    <p className="mt-3 text-sm text-muted-foreground">
                      Claiming is not live yet. This area will activate once the rewards pipeline is connected.
                    </p>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled
                      className="mt-3 w-full sm:w-auto"
                      data-testid="button-claim-referral-placeholder"
                    >
                      Claim rewards
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <Card data-testid="card-referral-code">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Gift className="h-4 w-4 text-foreground" />
                    Referral code
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="border border-border/70 bg-muted/15 px-3 py-3">
                    <div className="mb-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                      Current code
                    </div>
                    <div className="break-all text-sm text-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                      {referralMe.referralCode ?? "—"}
                    </div>
                  </div>

                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!referralMe.referralCode}
                    onClick={async () => {
                      if (!referralMe.referralCode) return;
                      await navigator.clipboard.writeText(referralMe.referralCode);
                      toast({ title: "Referral code copied" });
                    }}
                    data-testid="button-copy-referral-code"
                  >
                    <Copy className="mr-1.5 h-3.5 w-3.5" />
                    Copy code
                  </Button>

                  <div className="space-y-2">
                    <div className="text-sm text-muted-foreground">
                      Set your code using 4 to 16 uppercase letters or numbers.
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input
                        className="font-mono text-xs"
                        placeholder="e.g. MYCODE2025"
                        value={referralCodeDraft}
                        onChange={(e) => setReferralCodeDraft(e.target.value)}
                        data-testid="input-referral-code"
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={referralCodeDraft.trim().length < 4 || saveReferralCodeMutation.isPending}
                        onClick={() => saveReferralCodeMutation.mutate(referralCodeDraft)}
                        data-testid="button-save-referral-code"
                      >
                        Save code
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card data-testid="card-referral-waitlist">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Link2 className="h-4 w-4 text-foreground" />
                    Waitlist link
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {referralMe.referralProgramEnabled ? (
                    <>
                      <p className="text-sm text-muted-foreground">
                        Use the same email or Telegram ID you used on the TraderClaw waitlist to connect attribution.
                      </p>
                      <Input
                        className="text-xs"
                        type="email"
                        placeholder="Waitlist email"
                        value={waitlistEmail}
                        onChange={(e) => setWaitlistEmail(e.target.value)}
                        data-testid="input-waitlist-email"
                      />
                      <Input
                        className="font-mono text-xs"
                        placeholder="Telegram ID (if used on waitlist)"
                        value={waitlistTelegramId}
                        onChange={(e) => setWaitlistTelegramId(e.target.value)}
                        data-testid="input-waitlist-telegram"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={syncWaitlistMutation.isPending || (!waitlistEmail.trim() && !waitlistTelegramId.trim())}
                        onClick={() => syncWaitlistMutation.mutate()}
                        data-testid="button-sync-waitlist-referral"
                      >
                        Sync waitlist referral
                      </Button>
                      {referralMe.waitlistSyncedAt ? (
                        <div className="border border-border/70 bg-muted/10 px-3 py-3 text-sm text-muted-foreground" data-testid="text-waitlist-synced">
                          Linked at <span className="font-mono text-xs text-foreground">{new Date(referralMe.waitlistSyncedAt).toLocaleString()}</span>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <div className="border border-border/70 bg-muted/10 px-3 py-3 text-sm text-muted-foreground" data-testid="text-referral-program-disabled">
                      Referral linking activates when your operator enables the referral program for this environment.
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
