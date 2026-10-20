import * as React from "react"
import { cn } from "@arch/ui/lib/utils"

function Textarea({ className, autoComplete = "off", ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      autoComplete={autoComplete}
      data-1p-ignore={autoComplete === "off" ? true : undefined}
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base text-pretty transition-[color,background-color,border-color,box-shadow] duration-150 ease-out outline-none placeholder:text-muted-foreground hover:border-border-strong focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 md:text-ui dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
