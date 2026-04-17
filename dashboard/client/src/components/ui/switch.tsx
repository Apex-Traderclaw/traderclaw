import * as React from "react"
import * as SwitchPrimitives from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "peer relative inline-flex h-6 w-12 shrink-0 cursor-pointer items-center border border-border bg-background transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary/60 data-[state=checked]:bg-primary/10 data-[state=unchecked]:border-border data-[state=unchecked]:bg-muted/20",
      className
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none absolute left-1 top-1/2 block h-4 w-4 -translate-y-1/2 bg-muted-foreground ring-0 transition-[transform,background-color] duration-200 data-[state=checked]:translate-x-6 data-[state=checked]:bg-primary data-[state=unchecked]:translate-x-0 data-[state=unchecked]:bg-foreground/55"
      )}
    />
  </SwitchPrimitives.Root>
))
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
