"use client";
import Form from "next/form";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import type { DesignDraftScope } from "@/lib/ops/design-draft-types";
import { keepsDesignScope, parseDesignIndexQuery } from "@/lib/ops/design-index-query";

function useReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return ready;
}
export function DesignFilterForm({ children, className }: { children: ReactNode; className?: string }) {
  const ready = useReady();
  return (
    <Form
      action="/ops/designs"
      prefetch={false}
      scroll={false}
      className={className}
      data-design-filter-ready={ready ? "1" : undefined}
    >
      {children}
    </Form>
  );
}
export function DesignFilterLink({
  children,
  href,
  className,
}: {
  children: ReactNode;
  href: string;
  className?: string;
}) {
  const ready = useReady();
  return (
    <Link
      href={href}
      prefetch={false}
      scroll={false}
      className={className}
      data-design-filter-ready={ready ? "1" : undefined}
    >
      {children}
    </Link>
  );
}
export function preservesDesignFilter(target: HTMLAnchorElement | HTMLFormElement, scope: DesignDraftScope) {
  if (target.dataset.designFilterReady !== "1") return false;
  const form = target instanceof HTMLFormElement;
  const url = new URL(form ? target.action : target.href, window.location.href);
  if (
    url.origin !== window.location.origin ||
    url.pathname !== "/ops/designs" ||
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
  const query = parseDesignIndexQuery(search);
  return !!query && keepsDesignScope(query, scope);
}
