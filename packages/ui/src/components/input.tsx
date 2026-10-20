import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { cn } from "@arch/ui/lib/utils"

function Input({ className, type, autoComplete = "off", ...props }: React.ComponentProps<"input">) {
  // Credential fields opt in with an explicit autocomplete token.
  return (
    <InputPrimitive
      type={type}
      autoComplete={autoComplete}
      data-1p-ignore={autoComplete === "off" ? true : undefined}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-[color,background-color,border-color,box-shadow] duration-150 ease-out outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-ui file:font-medium file:text-foreground placeholder:text-muted-foreground hover:border-border-strong focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 md:text-ui dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
