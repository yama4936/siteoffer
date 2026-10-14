import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** class を結合し、Tailwind の重複指定は後勝ちにまとめる（shadcn/ui の cn） */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
