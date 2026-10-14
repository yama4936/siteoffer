import type * as React from "react";
import { cn } from "@/lib/utils";

export function Separator({ className, ...props }: React.ComponentProps<"hr">) {
  return <hr className={cn("my-4 border-0 border-t", className)} {...props} />;
}
