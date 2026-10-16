"use client";

import { ExternalLink, Monitor, RefreshCw, Smartphone } from "lucide-react";
import { startTransition, useEffect, useRef, useState } from "react";
import { openDeliveryPreview } from "@/app/(ops)/ops/delivery/[deliveryId]/review/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function DeliveryPreviewPair({
  deliveryId,
  selected,
  comparison,
}: {
  deliveryId: string;
  selected: { id: string; version: number; available: boolean };
  comparison?: { id: string; version: number; available: boolean };
}) {
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const chosen = useRef(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const sync = () => {
      if (!chosen.current) setDevice(media.matches ? "mobile" : "desktop");
    };
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  const chooseDevice = (next: "desktop" | "mobile") => {
    chosen.current = true;
    setDevice(next);
  };
  return (
    <section aria-label="制作版のプレビュー" className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">表示を確認し、リンクやメニューも操作できます。</p>
        <fieldset aria-label="表示サイズ" className="flex gap-2">
          <Button
            size="sm"
            variant={device === "desktop" ? "default" : "outline"}
            aria-pressed={device === "desktop"}
            onClick={() => chooseDevice("desktop")}
          >
            <Monitor />
            PC
          </Button>
          <Button
            size="sm"
            variant={device === "mobile" ? "default" : "outline"}
            aria-pressed={device === "mobile"}
            onClick={() => chooseDevice("mobile")}
          >
            <Smartphone />
            スマホ
          </Button>
        </fieldset>
      </div>
      <div className={cn("grid min-w-0 gap-4", comparison && "xl:grid-cols-2")}>
        {comparison && (
          <PreviewFrame
            key={comparison.id}
            deliveryId={deliveryId}
            version={comparison}
            device={device}
            label="比較する版"
          />
        )}
        <PreviewFrame key={selected.id} deliveryId={deliveryId} version={selected} device={device} label="確認する版" />
      </div>
      <p className="text-xs text-muted-foreground">
        運営専用の確認表示です。公開や顧客への送信は行いません。フォーム送信・外部サービスとの通信はプレビューでは制限されます。
      </p>
    </section>
  );
}

function PreviewFrame({
  deliveryId,
  version,
  device,
  label,
}: {
  deliveryId: string;
  version: { id: string; version: number; available: boolean };
  device: "desktop" | "mobile";
  label: string;
}) {
  const [grant, setGrant] = useState<{ url: string; expiresAt: string }>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [expired, setExpired] = useState(false);
  const [width, setWidth] = useState(390);
  const viewport = useRef<HTMLDivElement>(null);
  // StrictModeによる同じ表示の再実行でも余分な権限を発行しない。
  const request = useRef<{ revision: number; promise: ReturnType<typeof openDeliveryPreview> } | null>(null);
  useEffect(() => {
    if (!version.available) return;
    let active = true;
    setGrant(undefined);
    setError("");
    setLoaded(false);
    setExpired(false);
    startTransition(async () => {
      try {
        if (!request.current || request.current.revision !== revision)
          request.current = { revision, promise: openDeliveryPreview(deliveryId, version.id) };
        const result = await request.current.promise;
        if (!active) return;
        if (result.url && result.expiresAt) {
          if (new URL(result.url).origin === window.location.origin) throw new Error("separate origin required");
          const check = await fetch(result.url, {
            method: "HEAD",
            credentials: "omit",
            cache: "no-store",
            referrerPolicy: "no-referrer",
            signal: AbortSignal.timeout(15000),
          });
          if (!active) return;
          if (!check.ok) {
            setError(
              "この制作版を配信できません。再読み込みしても表示されない場合は、成果物と配信状態を確認してください。",
            );
            return;
          }
          setGrant({ url: result.url, expiresAt: result.expiresAt });
        } else setError(result.error || "プレビューを開けませんでした。");
      } catch {
        if (active) setError("プレビューを開けませんでした。接続を確認して、再読み込みしてください。");
      }
    });
    return () => {
      active = false;
    };
  }, [deliveryId, version.id, version.available, revision]);
  useEffect(() => {
    if (!grant) return;
    const timeout = setTimeout(() => setExpired(true), Math.max(0, new Date(grant.expiresAt).getTime() - Date.now()));
    return () => clearTimeout(timeout);
  }, [grant]);
  useEffect(() => {
    if (!viewport.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(1, entry.contentRect.width));
    });
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!grant || loaded || expired) return;
    const timeout = setTimeout(
      () => setError("表示の読み込みに時間がかかっています。配信状態を確認し、再読み込みしてください。"),
      20000,
    );
    return () => clearTimeout(timeout);
  }, [grant, loaded, expired]);
  const frameWidth = device === "mobile" ? 390 : 1280;
  const scale = Math.min(1, width / frameWidth);
  return (
    <section
      aria-label={`${label} 第${version.version}版`}
      className="min-w-0 overflow-hidden rounded-xl border bg-card shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
        <h3 className="text-sm font-semibold">
          {label} · 第{version.version}版
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {grant && !expired && (
            <a
              href={grant.url}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ size: "sm", variant: "ghost" })}
              aria-label={`${label} 第${version.version}版を別タブで開く`}
            >
              <ExternalLink />
              別タブ
            </a>
          )}
          {version.available && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRevision((x) => x + 1)}
              aria-label={`${label} 第${version.version}版を再読み込み`}
            >
              <RefreshCw />
              再読み込み
            </Button>
          )}
        </div>
      </div>
      <div ref={viewport} className="relative h-[640px] overflow-hidden bg-muted/30">
        {!version.available ? (
          <p className="p-6 text-sm">この版には表示できる成果物がありません。</p>
        ) : expired ? (
          <div role="status" className="p-6 text-sm space-y-3">
            <p>確認用の表示期限が切れました。再読み込みすると、引き続き確認できます。</p>
            <Button onClick={() => setRevision((x) => x + 1)}>表示を再開する</Button>
          </div>
        ) : (
          <>
            {grant && (
              <iframe
                title={`${label} 第${version.version}版`}
                src={grant.url}
                sandbox="allow-scripts allow-same-origin"
                referrerPolicy="no-referrer"
                className="block border-0 bg-white"
                style={{
                  width: frameWidth,
                  height: 640 / scale,
                  transform: `scale(${scale})`,
                  transformOrigin: "top left",
                }}
                onLoad={() => {
                  setLoaded(true);
                  setError("");
                }}
              />
            )}
            {!loaded && !error && (
              <p role="status" className="absolute inset-0 flex items-center justify-center bg-card/90 text-sm">
                プレビューを読み込んでいます…
              </p>
            )}
            {error && (
              <Alert role="alert" variant="destructive" className="absolute left-4 right-4 top-4 w-auto">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </>
        )}
      </div>
    </section>
  );
}
