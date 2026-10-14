import { cn } from "@/lib/utils";

/** ロゴの代わりの文字マーク */
export function Brand({ label, className }: { label?: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <span
        aria-hidden="true"
        className="grid size-7 place-items-center rounded-lg bg-primary font-bold text-primary-foreground text-xs"
      >
        SO
      </span>
      <span>
        SiteOffer
        {label ? <span className="ml-1.5 font-normal opacity-70">{label}</span> : null}
      </span>
    </span>
  );
}
