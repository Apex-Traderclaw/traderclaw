import type { CSSProperties, ReactNode } from "react";
import { SiSolana } from "react-icons/si";

import { cn } from "@/lib/utils";

type SolanaMarkProps = {
  className?: string;
  iconClassName?: string;
  title?: string;
};

export function SolanaMark({
  className,
  iconClassName,
  title = "Solana",
}: SolanaMarkProps) {
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className={cn(
        "inline-flex h-[0.95em] w-[0.95em] shrink-0 items-center justify-center align-[-0.08em]",
        className,
      )}
    >
      <SiSolana className={cn("h-full w-full text-foreground", iconClassName)} />
    </span>
  );
}

type SolAmountProps = {
  value: ReactNode;
  className?: string;
  valueClassName?: string;
  valueStyle?: CSSProperties;
  markClassName?: string;
  iconClassName?: string;
  title?: string;
};

export function SolAmount({
  value,
  className,
  valueClassName,
  valueStyle,
  markClassName,
  iconClassName,
  title,
}: SolAmountProps) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span className={valueClassName} style={valueStyle}>
        {value}
      </span>
      <SolanaMark className={markClassName} iconClassName={iconClassName} title={title} />
    </span>
  );
}
