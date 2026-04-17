import { useEffect } from "react";
import { useLocation } from "wouter";

type MetadataEntry = {
  title: string;
  description: string;
};

const SHARED_OG_IMAGE = "/og-dashboard.jpg";
const SHARED_OG_IMAGE_ALT = "TraderClaw dashboard preview with the headline Your AI Trading Desk";

const DEFAULT_METADATA: MetadataEntry = {
  title: "TraderClaw Dashboard | Solana Trading Control Center",
  description:
    "Operate Solana trading with live positions, signal filters, risk controls, entitlements, and agent oversight in TraderClaw.",
};

const ROUTE_METADATA: Array<{ match: (pathname: string) => boolean; metadata: MetadataEntry }> = [
  {
    match: (pathname) => pathname === "/",
    metadata: {
      title: "Dashboard | TraderClaw Trading Console",
      description:
        "Monitor wallet balance, live PnL, open positions, kill switch status, and strategy controls from the main TraderClaw dashboard.",
    },
  },
  {
    match: (pathname) => pathname.startsWith("/positions"),
    metadata: {
      title: "Positions | TraderClaw Trading Console",
      description:
        "Review open and closed positions, track realized and unrealized PnL, and manage agent sell controls inside TraderClaw.",
    },
  },
  {
    match: (pathname) => pathname.startsWith("/trade-log"),
    metadata: {
      title: "Trade Log | TraderClaw Trading Console",
      description:
        "Inspect executions, fills, and risk denials with a searchable audit trail for every TraderClaw trade.",
    },
  },
  {
    match: (pathname) => pathname.startsWith("/alpha"),
    metadata: {
      title: "Alpha Sources | TraderClaw Trading Console",
      description:
        "Manage signal sources, private groups, and token filter rules that feed alpha into your TraderClaw trading workflows.",
    },
  },
  {
    match: (pathname) => pathname.startsWith("/risk-strategy"),
    metadata: {
      title: "Risk Strategy | TraderClaw Trading Console",
      description:
        "Configure stop loss, take profit, trailing exits, slippage rules, and enforcement behavior for TraderClaw agent trades.",
    },
  },
  {
    match: (pathname) => pathname.startsWith("/buy-strategy"),
    metadata: {
      title: "Buy Strategy | TraderClaw Trading Console",
      description:
        "Set buy filters, token bounds, and enforcement modes to control which opportunities TraderClaw is allowed to execute.",
    },
  },
  {
    match: (pathname) => pathname.startsWith("/runtime"),
    metadata: {
      title: "Runtime | TraderClaw Trading Console",
      description:
        "View the active runtime plan, monitor remaining access, and buy more TraderClaw runtime with the available payment rails.",
    },
  },
  {
    match: (pathname) => pathname.startsWith("/staking"),
    metadata: {
      title: "Staking | TraderClaw Trading Console",
      description:
        "Connect a staking wallet, manage TCLAW stake and unstake actions, and review rewards and staking status from the TraderClaw dashboard.",
    },
  },
  {
    match: (pathname) => pathname.startsWith("/referral"),
    metadata: {
      title: "Referral | TraderClaw Trading Console",
      description:
        "Manage referral code, access window, waitlist linkage, and reward status for your TraderClaw account.",
    },
  },
  {
    match: (pathname) => pathname.startsWith("/entitlements"),
    metadata: {
      title: "Runtime | TraderClaw Trading Console",
      description:
        "View the active runtime plan, monitor remaining access, and buy more TraderClaw runtime with the available payment rails.",
    },
  },
  {
    match: (pathname) => pathname.startsWith("/store"),
    metadata: {
      title: "Store | TraderClaw Trading Console",
      description:
        "Explore TraderClaw extensions, skills packs, premium modules, and operator-ready upgrades outside the dedicated runtime flow.",
    },
  },
  {
    match: (pathname) => pathname.startsWith("/settings"),
    metadata: {
      title: "Settings | TraderClaw Trading Console",
      description:
        "Manage wallet details, API keys, kill switch controls, agent configuration, and account-level trading preferences.",
    },
  },
  {
    match: (pathname) => pathname.startsWith("/wallet-setup"),
    metadata: {
      title: "Wallet Setup | TraderClaw Trading Console",
      description:
        "Create, secure, and fund your Solana wallet to activate TraderClaw and start operating your trading dashboard.",
    },
  },
  {
    match: (pathname) => pathname.startsWith("/agent-logs"),
    metadata: {
      title: "Agent Logs | TraderClaw Trading Console",
      description:
        "Audit live streams, forward events, and system output for deeper visibility into TraderClaw agent activity.",
    },
  },
];

function setMetaTag(attribute: "name" | "property", key: string, content: string) {
  let tag = document.head.querySelector(`meta[${attribute}="${key}"]`);
  if (!tag) {
    tag = document.createElement("meta");
    tag.setAttribute(attribute, key);
    document.head.appendChild(tag);
  }
  tag.setAttribute("content", content);
}

function resolveMetadata(pathname: string): MetadataEntry {
  return ROUTE_METADATA.find((entry) => entry.match(pathname))?.metadata ?? {
    title: "Page Not Found | TraderClaw",
    description:
      "The page you requested could not be found inside TraderClaw. Return to the dashboard to continue managing your trading workspace.",
  };
}

export function RouteMetadata() {
  const [location] = useLocation();

  useEffect(() => {
    const metadata = resolveMetadata(location || "/");

    document.title = metadata.title;
    setMetaTag("name", "description", metadata.description);
    setMetaTag("property", "og:title", metadata.title);
    setMetaTag("property", "og:description", metadata.description);
    setMetaTag("property", "og:image", SHARED_OG_IMAGE);
    setMetaTag("property", "og:image:alt", SHARED_OG_IMAGE_ALT);
    setMetaTag("name", "twitter:title", metadata.title);
    setMetaTag("name", "twitter:description", metadata.description);
    setMetaTag("name", "twitter:image", SHARED_OG_IMAGE);
    setMetaTag("name", "twitter:image:alt", SHARED_OG_IMAGE_ALT);
  }, [location]);

  return null;
}

export { DEFAULT_METADATA, SHARED_OG_IMAGE, SHARED_OG_IMAGE_ALT };
