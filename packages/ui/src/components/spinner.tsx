import { useUiLabels } from "@arch/ui/lib/ui-labels"
import { cn } from "@arch/ui/lib/utils"
import { Loader2Icon } from "lucide-react"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  const labels = useUiLabels()
  return (
    <Loader2Icon data-slot="spinner" role="status" aria-label={labels.loading} className={cn("size-4 animate-spin", className)} {...props} />
  )
}

export { Spinner }
