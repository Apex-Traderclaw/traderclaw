/** SPL token ticker for UI copy (set via SpyFly root `VITE_TOKEN_TICKER`). Leading `$` is stripped. */
const rawTicker = String(import.meta.env.VITE_TOKEN_TICKER ?? 'OON').trim();
export const TOKEN_TICKER: string = rawTicker.replace(/^\$+/, '').toUpperCase() || 'OON';

/** Same ticker with leading `$` for display (e.g. `$OON`). */
export const TOKEN_TICKER_DOLLAR = `$${TOKEN_TICKER}`;

/** Prepended to referral codes in the dashboard (default `$`). Set `VITE_REFERRAL_CODE_DISPLAY_PREFIX=` to disable. */
function referralCodeDisplayPrefix(): string {
  const v = import.meta.env.VITE_REFERRAL_CODE_DISPLAY_PREFIX;
  if (v === undefined || v === null) return '$';
  return String(v);
}

/**
 * Formats the canonical API referral code for display and sharing (cosmetic `$` prefix only).
 * Does not change the value sent to the API.
 */
export function formatReferralCodeForDisplay(canonicalCode: string): string {
  const base = canonicalCode.replace(/^\$+/, '').trim().toUpperCase();
  const p = referralCodeDisplayPrefix();
  if (!p) return base;
  return `${p}${base}`;
}
