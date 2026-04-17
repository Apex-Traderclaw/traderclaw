/**
 * UI-only mock data for the Alpha page. Mirrors user_groups fields used in standardMonitor /
 * webapp (DisplayName, group_id, Agent_enabled). Replace with API calls when wired.
 */

export type AlphaSourceRow = {
  id: string;
  groupId: string;
  displayName: string;
  /** mirrors user_groups group_name or channel label */
  subtitle?: string;
  platform: "telegram" | "discord";
  agentEnabled: boolean;
  /**
   * True only when this row is a real `fromPreset` / platform preset row from the API.
   * Mock rows must stay false so we do not imply preset status in the UI.
   */
  isFromPreset?: boolean;
};

/**
 * Illustrative rows only — same shape as future `user_groups` + DisplayName data.
 * None of these are presets until wired to the backend.
 */
export const DEFAULT_ALPHA_SOURCES: AlphaSourceRow[] = [
  {
    id: "example-1",
    groupId: "-1002184…",
    displayName: "Jeffrey Alpha+",
    subtitle: "Example: curated Telegram feed",
    platform: "telegram",
    agentEnabled: true,
    isFromPreset: false,
  },
  {
    id: "example-2",
    groupId: "-1003391…",
    displayName: "Main Desk Signals",
    subtitle: "Example: desk-style monitor",
    platform: "telegram",
    agentEnabled: true,
    isFromPreset: false,
  },
  {
    id: "example-3",
    groupId: "987654321012345678",
    displayName: "Discord Alpha — Desk",
    subtitle: "Example: Discord channel row",
    platform: "discord",
    agentEnabled: true,
    isFromPreset: false,
  },
];

export const DEMO_TELEGRAM_DEEP_LINK = "https://t.me/traderclaw?start=auth_12717454";

export type DiscoverableGroup = {
  id: string;
  title: string;
  platform: "telegram" | "discord";
};

export const DEMO_TG_GROUPS: DiscoverableGroup[] = [
  { id: "tg-1", title: "Solana Gems Alpha", platform: "telegram" },
  { id: "tg-2", title: "Memecoin Radar | VIP", platform: "telegram" },
  { id: "tg-3", title: "Whale Watch Alerts", platform: "telegram" },
];

export const DEMO_DISCORD_CHANNELS: DiscoverableGroup[] = [
  { id: "dc-1", title: "#alpha-feed", platform: "discord" },
  { id: "dc-2", title: "#signals-premium", platform: "discord" },
  { id: "dc-3", title: "#public-calls", platform: "discord" },
];

/** Sample portal URLs for share preview — not live until subscriber portals ship. */
export const PORTAL_SHARE_FRIENDS_SAMPLE =
  "https://portal.traderclaw.ai/u/your-handle/alpha?visibility=friends";
export const PORTAL_SHARE_PUBLIC_SAMPLE =
  "https://portal.traderclaw.ai/u/your-handle/alpha?visibility=public";

/**
 * Illustrative earnings preview when alpha is public — UI only, not financial advice.
 */
export type PublicAlphaEarningsPreview = {
  /** Estimated revenue share % on trades attributed to your published alpha (mock). */
  estimatedSharePercent: number;
  /** Mock count of attributed closed trades (last 30d). */
  tradesAttributedLast30d: number;
  /** Mock estimated USD from attributed fee share (preview). */
  estimatedUsdPreview: number;
  /** Mock SOL equivalent label (same USD basis). */
  estimatedSolPreview: number;
};

export const PUBLIC_ALPHA_EARNINGS_PREVIEW: PublicAlphaEarningsPreview = {
  estimatedSharePercent: 12.5,
  tradesAttributedLast30d: 47,
  estimatedUsdPreview: 128.4,
  estimatedSolPreview: 0.84,
};
