import { switchDesignInputAction } from "@/app/(ops)/ops/designs/actions";
import type { assessWorkers } from "@/lib/ops/processing";
import { DesignSubmit } from "./design-controls";

type Availability = Pick<ReturnType<typeof assessWorkers>, "image">;
export function DesignWorkerStatus({
  image,
  companyId,
  design,
}: Availability & { companyId: string; design?: { id: string; status: string; source: string } }) {
  return (
    <section id="design-queue" tabIndex={-1} className="design-worker-status" aria-label="制作の受付状況">
      <div className={`design-availability ${image.status === "ready" ? "" : "attention"}`}>
        <h3>画像生成 · {image.label}</h3>
        <p className="design-worker-copy">{image.detail}</p>
      </div>
      {design?.status === "queued" && design.source === "openai" && (
        <form action={switchDesignInputAction} className="design-queue-switch">
          <h3>待機中の依頼を、画像の取り込みへ切り替える</h3>
          <p className="design-worker-copy">
            この版の制作条件を保ち、API生成の依頼を取り消します。取り込み後に画像の確認とPDF出力へ進めます。
          </p>
          <p className="design-worker-copy">すでに生成が始まっている場合は切り替えず、現在の処理を続けます。</p>
          <input type="hidden" name="companyId" value={companyId} />
          <input type="hidden" name="designId" value={design.id} />
          <DesignSubmit secondary>開始前の生成を取り消し、画像取り込みへ</DesignSubmit>
        </form>
      )}
    </section>
  );
}
