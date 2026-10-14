import type * as React from "react";
import { cn } from "@/lib/utils";
import { controlClass } from "./input";

/** ブラウザ標準の select に shadcn/ui の見た目を当てたもの（JavaScriptなしでフォーム送信できる） */
export function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return <select className={cn(controlClass, "h-9 cursor-pointer pr-8", className)} {...props} />;
}
