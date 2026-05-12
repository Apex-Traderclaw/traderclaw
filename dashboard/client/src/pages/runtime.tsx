import { useQuery } from '@tanstack/react-query';
import { RuntimeAccessSections } from '@/components/runtime-access-sections';
import {
  OPENCLAW_RUNTIME_HOLD_MIN_TCLAW_LABEL,
  runtimeHoldUnlimitedBalanceNote,
  runtimeHoldUnlimitedSubtitle,
} from '@/lib/runtime-hold-copy';
import { TOKEN_TICKER_DOLLAR } from '@/lib/token-config';

type ReferralMeHoldFields = {
  runtimeHoldMinTclaw?: number | null;
};

export default function RuntimePage() {
  const { data: referralMe } = useQuery<ReferralMeHoldFields | null>({
    queryKey: [
      '/api/referral/me',
    ],
  });
  const holdMinRaw = referralMe?.runtimeHoldMinTclaw;
  const holdMin =
    holdMinRaw != null && Number.isFinite(Number(holdMinRaw)) && Number(holdMinRaw) > 0 ? Number(holdMinRaw) : null;

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6" data-testid="page-runtime">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold" data-testid="text-runtime-title">
          Runtime
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          View the active runtime plan on this wallet and buy more runtime with the available payment rails.
          <br />
          This surface is dedicated to execution time, active access windows, and staged checkout flows for SOL and{' '}
          {TOKEN_TICKER_DOLLAR}.
          {holdMin != null ? (
            <>
              <br />
              <br />
              <span className="text-foreground/90">{runtimeHoldUnlimitedSubtitle(holdMin)}</span>
              <br />
              <span className="mt-1 inline-block font-mono text-[11px] text-muted-foreground">
                Threshold from {OPENCLAW_RUNTIME_HOLD_MIN_TCLAW_LABEL} when SPL hold-unlimited is enabled on the API.
              </span>
              <span className="mt-2 block text-[11px] leading-relaxed text-muted-foreground">
                {runtimeHoldUnlimitedBalanceNote()}
              </span>
            </>
          ) : null}
        </p>
      </div>
      <RuntimeAccessSections />
    </div>
  );
}
