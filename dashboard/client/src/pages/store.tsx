import type { ComponentType } from "react";
import {
  Certificate,
  Clock,
  ShieldCheckered,
  Waveform,
  Zap,
} from "@/components/ui/icons";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type StoreOffering = {
  id: string;
  pretitle: string;
  title: string;
  summary: string;
  details: string[];
  launchState: string;
  icon: ComponentType<{ className?: string }>;
};

const STORE_OFFERINGS: StoreOffering[] = [
  {
    id: "alpha-premium-sources",
    pretitle: "Signals",
    title: "Alpha premium sources",
    summary:
      "Premium signal feeds and deeper source layering for desks that want broader coverage and earlier insight windows.",
    details: [
      "Access higher-quality source packages staged for advanced signal review.",
      "Unlock deeper context around the streams feeding the Alpha workflow.",
      "Designed for operators who want more surface area before execution decisions.",
    ],
    launchState: "Priority queue",
    icon: Waveform,
  },
  {
    id: "skills",
    pretitle: "Workflows",
    title: "Skills",
    summary:
      "Operator skill packs that bundle repeatable desk workflows into ready-to-activate modules.",
    details: [
      "Load structured workflow packs for review, execution support, and operational routines.",
      "Use curated desk skills without rebuilding the same flow for every wallet or operator.",
      "Planned as a modular layer that expands the desk without touching execution logic.",
    ],
    launchState: "Curated rollout",
    icon: Zap,
  },
  {
    id: "strategies",
    pretitle: "Strategy",
    title: "Strategies",
    summary:
      "Buy-side and risk-side strategy products that extend the desk with more specialized policy layers.",
    details: [
      "Includes future buy strategy packages for different market conditions and entry logic.",
      "Includes future risk strategy layers for tighter rejection, protection, and control handling.",
      "Built as add-on strategy surfaces for desks that want more specialized configuration paths.",
    ],
    launchState: "Desk roadmap",
    icon: ShieldCheckered,
  },
  {
    id: "runtime",
    pretitle: "Access",
    title: "Runtime",
    summary:
      "Runtime top-ups and plan access presented here as a store product surface in addition to the dedicated Runtime page.",
    details: [
      "Show active runtime plan and purchase additional runtime from the same product layer.",
      "Stage purchase rails for SOL and $TCLAW when the runtime checkout is enabled.",
      "Ideal for users who want runtime buying surfaced directly inside the broader Store flow.",
    ],
    launchState: "Purchase staging",
    icon: Clock,
  },
  {
    id: "entitlements",
    pretitle: "Data",
    title: "Entitlements",
    summary:
      "Bitquery data packages and related entitlement layers for desks that need wider data access.",
    details: [
      "Planned packages for richer Bitquery-backed access and higher-volume data visibility.",
      "Use entitlement layers to unlock premium data access without changing the rest of the desk.",
      "Structured for desks that need stronger data depth across research and monitoring workflows.",
    ],
    launchState: "Data packages",
    icon: Certificate,
  },
];

export default function StorePage() {
  return (
    <div className="space-y-8 px-4 py-4 sm:px-6 sm:py-6" data-testid="page-store">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold" data-testid="text-store-title">
            Store
          </h1>
          <Badge
            variant="outline"
            className="border-primary/25 bg-primary/10 px-2.5 py-1 text-[9px] font-mono uppercase tracking-[0.16em] text-primary"
          >
            Coming soon
          </Badge>
        </div>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          The Store is staged as the product layer for upcoming TraderClaw add-ons, premium access,
          and desk extensions.
          <br />
          These surfaces are being prepared for runtime, signals, data, skills, and strategy
          products.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {STORE_OFFERINGS.map((item) => {
          const Icon = item.icon;

          return (
            <Card
              key={item.id}
              className="flex h-full flex-col border-0 card-glow"
              data-testid={`card-store-${item.id}`}
            >
              <CardHeader className="space-y-4 pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div
                      className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      {item.pretitle}
                    </div>
                    <CardTitle className="text-base">{item.title}</CardTitle>
                  </div>
                  <Badge
                    variant="outline"
                    className="border-primary/25 bg-primary/10 px-2.5 py-1 text-[9px] font-mono uppercase tracking-[0.14em] text-primary"
                  >
                    Coming soon
                  </Badge>
                </div>

                <div className="flex items-center gap-4">
                  <span className="inline-flex shrink-0 items-center justify-center text-primary">
                    <Icon className="h-7 w-7" />
                  </span>
                  <p className="text-sm leading-6 text-muted-foreground">{item.summary}</p>
                </div>
              </CardHeader>

              <CardContent className="flex-1 space-y-4 pt-0">
                <div className="space-y-2 border-t border-border/70 pt-4">
                  {item.details.map((detail) => (
                    <div
                      key={detail}
                      className="text-sm leading-6 text-muted-foreground"
                    >
                      {detail}
                    </div>
                  ))}
                </div>

                <div className="border-t border-border/70 pt-4">
                  <div
                    className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground"
                    style={{ fontFamily: "var(--font-mono)" }}
                  >
                    Launch state
                  </div>
                  <div className="mt-1 text-sm text-foreground">{item.launchState}</div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
