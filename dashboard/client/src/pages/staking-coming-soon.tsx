import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Lock } from '@/components/ui/icons';
import { TOKEN_TICKER } from '@/lib/token-config';

/**
 * Lightweight placeholder until staking backend + flows are wired; toggled via
 * `VITE_DASHBOARD_STAKING_COMING_SOON` in repo root `.env`.
 */
export default function StakingComingSoonPage() {
  return (
    <div className="space-y-6 px-4 py-10 sm:px-6 sm:py-14" data-testid="page-staking-coming-soon">
      <div className="mx-auto max-w-lg">
        <Card className="border-border/80">
          <CardHeader className="space-y-1 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-none border border-border/80 bg-muted/20">
              <Lock className="h-6 w-6 text-muted-foreground" aria-hidden />
            </div>
            <CardTitle className="font-mono text-lg tracking-[0.08em] uppercase">Staking · Coming soon</CardTitle>
            <CardDescription className="text-sm leading-relaxed text-muted-foreground">
              {TOKEN_TICKER} staking, tier previews, and on-chain linking are not live in this dashboard build yet.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center text-[13px] leading-relaxed text-muted-foreground pb-8">
            We will unlock staking soon.
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
