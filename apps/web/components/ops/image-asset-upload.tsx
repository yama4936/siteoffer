"use client";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { uploadImageAssetAction } from "@/app/image-asset-actions";
import { Button } from "@/components/ui/button";
export function ImageAssetUpload({
  companyId,
  assetId,
  label,
  file,
}: {
  companyId: string;
  assetId: string;
  label: string;
  file: { width: number; height: number; byteSize: number } | null;
}) {
  const id = useId(),
    router = useRouter(),
    sending = useRef(false),
    [busy, start] = useTransition(),
    [message, setMessage] = useState<{ ok: boolean; message: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="mt-3 space-y-2">
      {file ? (
        <>
          <a
            href={`/ops/image-assets/${assetId}/file`}
            target="_blank"
            rel="noreferrer"
            aria-label={`${label}の画像を確認`}
          >
            {/* biome-ignore lint/performance/noImgElement: 運営の認証Cookieが必要な非公開画像 */}
            <img
              src={`/ops/image-assets/${assetId}/file`}
              alt={label}
              className="h-28 max-w-48 rounded border bg-muted object-contain"
            />
          </a>
          <p className="text-xs text-muted-foreground">
            {file.width}×{file.height} · {Math.ceil(file.byteSize / 1024)}KB · 登録済み
          </p>
          <p className="text-xs text-muted-foreground">別の画像は新しい素材として登録してください。</p>
        </>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (sending.current) return;
            const image = input.current?.files?.[0];
            if (!image) {
              setMessage({ ok: false, message: "画像を選択してください" });
              return;
            }
            if (image.size > 12 * 1024 * 1024) {
              setMessage({ ok: false, message: "12MB以下の画像を選択してください" });
              return;
            }
            const fd = new FormData();
            fd.set("companyId", companyId);
            fd.set("assetId", assetId);
            fd.set("image", image);
            sending.current = true;
            start(async () => {
              try {
                const result = await uploadImageAssetAction(fd);
                setMessage(result);
                if (result.ok) router.refresh();
              } catch {
                setMessage({ ok: false, message: "通信結果を確認できません。同じ画像で再試行できます。" });
              } finally {
                sending.current = false;
              }
            });
          }}
        >
          <label htmlFor={id} className="block text-xs">
            {label}の画像ファイル
          </label>
          <input
            id={id}
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={busy}
            className="block max-w-52 text-xs"
          />
          <Button type="submit" size="sm" variant="outline" disabled={busy}>
            {busy ? "取り込み中…" : "画像を取り込む"}
          </Button>
          <p className="max-w-52 text-xs text-muted-foreground">
            PNG・JPEG・WebP / 12MBまで。取込後に画像を確認し、利用許諾を設定してください。
          </p>
        </form>
      )}
      {message && (
        <p role={message.ok ? "status" : "alert"} className="max-w-64 break-words text-xs">
          {message.message}
        </p>
      )}
    </div>
  );
}
