import type * as React from "react";
import { cn } from "@/lib/utils";

export const controlClass =
  "w-full min-w-0 rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20";

export function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  if (type === "checkbox" || type === "radio") {
    return <input type={type} className={cn("size-4 shrink-0 accent-primary", className)} {...props} />;
  }
  return <input type={type} className={cn(controlClass, "h-9", className)} {...props} />;
}
