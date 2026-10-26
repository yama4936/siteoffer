import type * as React from "react";
import { cn } from "@/lib/utils";

/** ページ上部の見出し（タイトル・説明・右側の操作） */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  eyebrow?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      <div className="min-w-0 space-y-1">
        {eyebrow ? <div className="text-muted-foreground text-xs">{eyebrow}</div> : null}
        <h1 className="font-semibold text-2xl tracking-tight">{title}</h1>
        {description ? <div className="max-w-3xl text-muted-foreground text-sm">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** 見出し付きの区切り（カードではなく、ページ内の段落） */
export function Section({
  title,
  description,
  actions,
  id,
  className,
  children,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={id && title ? `${id}-heading` : undefined}
      className={cn("mb-8 space-y-3", className)}
    >
      {title || actions ? (
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="space-y-0.5">
            {title ? (
              <h2 id={id ? `${id}-heading` : undefined} className="font-semibold text-lg tracking-tight">
                {title}
              </h2>
            ) : null}
            {description ? <div className="text-muted-foreground text-sm">{description}</div> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** 項目名と値の一覧（スマホでは縦に積む） */
export function DescriptionList({ className, ...props }: React.ComponentProps<"dl">) {
  return (
    <dl
      className={cn(
        "grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-[max-content_1fr] [&>dd]:mb-2 [&>dd]:break-words sm:[&>dd]:mb-0 [&>dt]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** 数値を目立たせる小さなカード */
export function Stat({
  label,
  value,
  hint,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl border bg-card p-4 shadow-xs", className)}>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="mt-1 font-semibold text-2xl tabular-nums tracking-tight">{value}</div>
      {hint ? <div className="mt-1 text-muted-foreground text-xs">{hint}</div> : null}
    </div>
  );
}

/** 件数ゼロなどの空の表示 */
export function EmptyState({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-lg border border-dashed bg-card/50 px-4 py-8 text-center text-muted-foreground text-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** 補足の小さな文字 */
export function Muted({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("text-muted-foreground text-sm", className)} {...props} />;
}
