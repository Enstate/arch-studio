import { cn } from "@arch/ui/lib/utils"

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-4.5 w-fit min-w-4.5 items-center justify-center gap-0.5 rounded-[5px] border border-border bg-linear-to-b from-background to-muted px-1 font-sans text-[10px] leading-none font-medium text-muted-foreground tabular-nums shadow-[inset_0_-1px_0_var(--border)] select-none in-data-[slot=tooltip-content]:border-background/20 in-data-[slot=tooltip-content]:bg-background/15 in-data-[slot=tooltip-content]:bg-none in-data-[slot=tooltip-content]:text-background in-data-[slot=tooltip-content]:shadow-[inset_0_-1px_0_color-mix(in_oklab,var(--background)_25%,transparent)] dark:in-data-[slot=tooltip-content]:bg-background/10 [&_svg:not([class*='size-'])]:size-3",
        className
      )}
      {...props}
    />
  )
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  )
}

export { Kbd, KbdGroup }
