import type * as React from "react";
import { cn } from "@/lib/utils";
import { controlClass } from "./input";

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea className={cn(controlClass, "min-h-20 py-2 leading-relaxed", className)} {...props} />;
}
