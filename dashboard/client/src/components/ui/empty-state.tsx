import type { ElementType, ReactNode } from "react";

import { cn } from "@/lib/utils";

type EmptyStateProps = {
  icon: ElementType;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
  framed?: boolean;
};

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  compact = false,
  framed = true,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        framed && "border border-border/70 bg-muted/10",
        compact ? "px-4 py-8" : "px-5 py-10 sm:px-6",
        className,
      )}
    >
      <div
        className={cn(
          "mx-auto flex w-full max-w-[30rem] flex-col items-center text-center",
          compact ? "gap-3" : "gap-4",
        )}
      >
        <span
          className={cn(
            "inline-flex items-center justify-center border border-border/70 bg-background/30 text-primary",
            compact ? "h-11 w-11" : "h-12 w-12",
          )}
        >
          <Icon className={cn(compact ? "h-5 w-5" : "h-[1.35rem] w-[1.35rem]")} />
        </span>

        <div className="space-y-1.5">
          <div
            className={cn(
              "font-mono font-medium tracking-[0.03em] text-foreground",
              compact ? "text-sm" : "text-[0.95rem]",
            )}
          >
            {title}
          </div>
          {description ? (
            <div
              className={cn(
                "text-muted-foreground",
                compact ? "text-xs leading-5" : "text-sm leading-6",
              )}
            >
              {description}
            </div>
          ) : null}
        </div>

        {action ? <div className="pt-1">{action}</div> : null}
      </div>
    </div>
  );
}
