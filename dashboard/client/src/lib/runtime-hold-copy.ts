import { TOKEN_TICKER, TOKEN_TICKER_DOLLAR } from '@/lib/token-config';

/** Nominal token amount for runtime hold banners (same scale as SPL `uiAmount`). */
export function formatRuntimeHoldMinTclaw(n: number): string {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: n < 1000 ? 2 : 0,
  }).format(n);
}

export function runtimeHoldUnlimitedSubtitle(minTclaw: number): string {
  const qty = formatRuntimeHoldMinTclaw(minTclaw);
  return `Link a Solana address below and hold at least ${qty} ${TOKEN_TICKER_DOLLAR} (SPL) on that address alone — we verify only this linked wallet.`;
}

export function runtimeHoldUnlimitedBalanceNote(): string {
  return `${TOKEN_TICKER_DOLLAR} on your linked Solana address is verified on every gated request; if you sell below the minimum there, unlimited access ends on the next request. Linking that address requires a one-time wallet message signature — your seed phrase is never collected.`;
}

export const OPENCLAW_RUNTIME_HOLD_MIN_TCLAW_LABEL = 'OPENCLAW_RUNTIME_HOLD_MIN_TCLAW';

export function unlimitedRuntimePlanLabel(flags: {
  stakingUnlimitedRuntime: boolean;
  holdTclawUnlimitedRuntime: boolean;
}): string {
  if (flags.stakingUnlimitedRuntime && flags.holdTclawUnlimitedRuntime) {
    return `Unlimited (staking + ${TOKEN_TICKER})`;
  }
  if (flags.stakingUnlimitedRuntime) {
    return 'Unlimited (staking)';
  }
  if (flags.holdTclawUnlimitedRuntime) {
    return `Unlimited (${TOKEN_TICKER} hold)`;
  }
  return 'Unlimited';
}

export function unlimitedRuntimeExplanation(flags: {
  stakingUnlimitedRuntime: boolean;
  holdTclawUnlimitedRuntime: boolean;
}): string {
  if (flags.stakingUnlimitedRuntime && flags.holdTclawUnlimitedRuntime) {
    return `Unlimited agent runtime from staking and SPL ${TOKEN_TICKER} holdings.`;
  }
  if (flags.stakingUnlimitedRuntime) {
    return 'Unlimited agent runtime from your staking tier.';
  }
  if (flags.holdTclawUnlimitedRuntime) {
    return `Unlimited agent runtime from SPL ${TOKEN_TICKER_DOLLAR} at or above the threshold on your linked Solana wallet (verified each request).`;
  }
  return 'Open-ended runtime on this account.';
}
