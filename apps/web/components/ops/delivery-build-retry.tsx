"use client";
import { useRouter } from "next/navigation";
import { startTransition, useRef, useState } from "react";
import { retryDeliveryBuildAction } from "@/app/(ops)/ops/actions";
import { Button } from "@/components/ui/button";

export function DeliveryBuildRetry({ deliveryId, buildId }: { deliveryId: string; buildId: string }) {
  const router = useRouter(),
    sending = useRef(false);
  const [pending, setPending] = useState(false),
    [message, setMessage] = useState("");
  async function retry() {
    if (sending.current) return;
    sending.current = true;
    setPending(true);
    setMessage("");
    try {
      const result = await retryDeliveryBuildAction(deliveryId, buildId);
      setMessage(result.message);
    } catch {
      setMessage(
        "結果を確認できませんでした。最新の状態を確認してください。もう一度押しても、同じ制作依頼は重複しません。",
      );
    } finally {
      sending.current = false;
      setPending(false);
    }
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={pending} onClick={() => startTransition(retry)}>
          {pending ? "受付を確認しています…" : "制作を再試行する"}
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => router.refresh()}>
          最新の状態を確認
        </Button>
      </div>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </div>
  );
}
