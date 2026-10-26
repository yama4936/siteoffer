"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
export function DiscoveryRefresh() {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName ?? "")
      )
        router.refresh();
    }, 5000);
    return () => clearInterval(id);
  }, [router]);
  return (
    <p className="mb-3 text-xs text-muted-foreground">状態を5秒ごとに自動更新しています。入力中は更新を待機します。</p>
  );
}
