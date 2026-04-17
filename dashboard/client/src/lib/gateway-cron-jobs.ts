/**
 * Gateway cron job definitions aligned with traderClaw_plugin gateway-v1-upgraded.json5.
 * UI-only: descriptions are shortened; full agent prompts live in the gateway file.
 */

export type GatewayCronJobCategory =
  | "Strategy & Learning"
  | "Risk & Audit"
  | "On-Chain Intelligence"
  | "Portfolio Maintenance"
  | "Reporting"
  | "Whale / Smart Money"
  | "Alpha Scanning"
  | "Intelligence Lab"
  | "Memory Maintenance";

export type GatewayCronJobDef = {
  id: string;
  title: string;
  shortDescription: string;
  defaultSchedule: string;
  category: GatewayCronJobCategory;
};

export const GATEWAY_CRON_GLOBAL = {
  maxConcurrentRuns: 2,
  sessionRetention: "24h",
} as const;

export const GATEWAY_CRON_JOBS: GatewayCronJobDef[] = [
  {
    id: "strategy-evolution",
    title: "Strategy evolution",
    shortDescription:
      "Reviews journal stats, memory, and closed trades; adjusts strategy weights with VFM scoring and guardrails. Read-only tool steps except approved updates.",
    defaultSchedule: "0 */4 * * *",
    category: "Strategy & Learning",
  },
  {
    id: "source-reputation",
    title: "Source reputation",
    shortDescription:
      "Scores each alpha source from signal history and trade outcomes; assigns tiers and writes a reputation scorecard to memory.",
    defaultSchedule: "0 */3 * * *",
    category: "Strategy & Learning",
  },
  {
    id: "risk-audit",
    title: "Portfolio risk audit",
    shortDescription:
      "Checks capital, positions, concentration, exposure, drawdown, heat, liquidity, and kill switch; writes a risk report.",
    defaultSchedule: "0 */2 * * *",
    category: "Risk & Audit",
  },
  {
    id: "meta-rotation",
    title: "Meta rotation analysis",
    shortDescription:
      "Combines social search with recent launches; clusters narratives and classifies rotation (gaining, saturated, cooling, dormant).",
    defaultSchedule: "30 */3 * * *",
    category: "On-Chain Intelligence",
  },
  {
    id: "dead-money-sweep",
    title: "Dead money sweep",
    shortDescription:
      "Finds stalled losing positions matching dead-money rules and exits them; logs sweep results. Executes sells per config.",
    defaultSchedule: "0 */2 * * *",
    category: "Portfolio Maintenance",
  },
  {
    id: "subscription-cleanup",
    title: "Bitquery subscription cleanup",
    shortDescription:
      "Matches Bitquery subscriptions to open positions; unsubscribes orphans and reopens subs near expiry.",
    defaultSchedule: "0 * * * *",
    category: "Portfolio Maintenance",
  },
  {
    id: "daily-report",
    title: "Daily performance report",
    shortDescription:
      "Builds a 24h report from journal, capital, positions, trades, strategy state, and memory; writes tagged daily performance.",
    defaultSchedule: "0 4 * * *",
    category: "Reporting",
  },
  {
    id: "whale-watch",
    title: "Whale activity scan",
    shortDescription:
      "Compares holder distributions to baseline; flags whale exits, deployer moves, and concentration changes on held tokens.",
    defaultSchedule: "0 */2 * * *",
    category: "Whale / Smart Money",
  },
  {
    id: "alpha-scan",
    title: "Alpha scan",
    shortDescription:
      "Scans new launches, filters volume/mcap and holders, risk and optional website checks; submits candidates to the alpha buffer.",
    defaultSchedule: "0 * * * *",
    category: "Alpha Scanning",
  },
  {
    id: "intelligence-lab-eval",
    title: "Intelligence lab evaluation",
    shortDescription:
      "Evaluates labeled candidates, runs metrics and optional challenger replay; promotes model when criteria are met.",
    defaultSchedule: "0 */12 * * *",
    category: "Intelligence Lab",
  },
  {
    id: "source-trust-refresh",
    title: "Source & deployer trust refresh",
    shortDescription:
      "Recalculates source and deployer trust from recent outcomes; flags low-trust sources and repeat failed deployers.",
    defaultSchedule: "0 */6 * * *",
    category: "Intelligence Lab",
  },
  {
    id: "memory-trim",
    title: "Memory trim",
    shortDescription:
      "Dry-run then prunes old memory entries with a short retention window; logs trim statistics.",
    defaultSchedule: "0 3 * * *",
    category: "Memory Maintenance",
  },
];
