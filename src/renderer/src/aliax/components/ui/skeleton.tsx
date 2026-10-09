import { cn } from "@aliax/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-ax-accent", className)}
      {...props}
    />
  )
}

export { Skeleton }
