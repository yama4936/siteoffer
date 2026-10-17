"use client";
import Form from "next/form";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { keepsArticleEditor, parseContentIndexQuery } from "@/lib/content-index-query";

function useReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return ready;
}
/** Opt in only after hydration: native navigation must retain the normal unsaved-input guard. */
export function ContentFilterForm({
  action,
  className,
  children,
}: {
  action: string;
  className?: string;
  children: ReactNode;
}) {
  const ready = useReady();
  return (
    <Form
      action={action}
      prefetch={false}
      scroll={false}
      className={className}
      data-content-filter-ready={ready ? "1" : undefined}
    >
      {children}
    </Form>
  );
}
export function ContentFilterLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const ready = useReady();
  return (
    <Link
      href={href}
      prefetch={false}
      scroll={false}
      className={className}
      data-content-filter-ready={ready ? "1" : undefined}
    >
      {children}
    </Link>
  );
}
export function preservesArticleFilter(
  target: HTMLAnchorElement | HTMLFormElement,
  scope: { companyId: string; entryId: string | null },
  base: string,
) {
  if (target.dataset.contentFilterReady !== "1") return false;
  const form = target instanceof HTMLFormElement;
  const url = new URL(form ? target.action : target.href, window.location.href);
  if (
    url.origin !== window.location.origin ||
    url.pathname !== base ||
    (form && (target.method !== "get" || url.search))
  )
    return false;
  const params = form ? new URLSearchParams() : url.searchParams;
  if (form)
    for (const [key, value] of new FormData(target)) {
      if (typeof value !== "string") return false;
      params.append(key, value);
    }
  const search = Object.fromEntries(
    [...new Set(params.keys())].map((key) => [
      key,
      params.getAll(key).length === 1 ? params.get(key)! : params.getAll(key),
    ]),
  );
  const query = parseContentIndexQuery(search);
  return !!query && keepsArticleEditor(query, scope);
}
