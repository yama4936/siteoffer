"use client";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";

export function DeliveryVersionPicker({
  deliveryId,
  selectedId,
  comparisonId,
  versions,
}: {
  deliveryId: string;
  selectedId: string;
  comparisonId: string;
  versions: { id: string; version: number }[];
}) {
  const router = useRouter(),
    [pending, startTransition] = useTransition();
  const navigate = (version: string, compare: string) =>
    startTransition(() =>
      router.push(`/ops/delivery/${deliveryId}/review?version=${version}&compare=${compare}`, { scroll: false }),
    );
  return (
    <div className="flex flex-wrap items-end gap-4 rounded-xl border bg-card p-4">
      <div className="grid gap-2">
        <Label htmlFor="delivery-version">確認する版</Label>
        <NativeSelect
          id="delivery-version"
          value={selectedId}
          disabled={pending}
          onChange={(e) => navigate(e.target.value, comparisonId === e.target.value ? "none" : comparisonId)}
          className="w-48"
        >
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              第{v.version}版
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="delivery-compare">比較する版</Label>
        <NativeSelect
          id="delivery-compare"
          value={comparisonId === selectedId ? "none" : comparisonId}
          disabled={pending}
          onChange={(e) => navigate(selectedId, e.target.value)}
          className="w-48"
        >
          <option value="none">比較しない</option>
          {versions
            .filter((v) => v.id !== selectedId)
            .map((v) => (
              <option key={v.id} value={v.id}>
                第{v.version}版
              </option>
            ))}
        </NativeSelect>
      </div>
      {pending && (
        <p role="status" className="text-sm text-muted-foreground">
          表示する版を切り替えています…
        </p>
      )}
    </div>
  );
}
