import Link from "next/link";
import { DESIGN_STEPS, type DesignJourneyInput, designJourney } from "@/lib/ops/design-journey";

export function DesignJourney(props: DesignJourneyInput) {
  const journey = designJourney(props);
  const imageReady = !!props.design?.imageSha256;
  const proposalReady = imageReady && props.design?.status === "approved" && props.proposal?.status === "approved";
  return (
    <section className="design-journey" aria-label="制作の進み具合と次の操作">
      <ol className="design-progress" aria-label="制作の手順">
        {DESIGN_STEPS.map((label, index) => (
          <li
            key={label}
            aria-current={index === journey.step ? "step" : undefined}
            className={index < journey.step ? "complete" : index === journey.step ? "current" : ""}
          >
            <span aria-hidden="true">{index < journey.step ? "✓" : index + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      <div className="design-next">
        <div>
          <p className="design-eyebrow">{journey.waiting ? "処理の状況" : "次にすること"}</p>
          <h2>{journey.title}</h2>
          <p>{journey.description}</p>
        </div>
        {journey.href.startsWith("#") ? (
          <a className="design-button" href={journey.href}>
            {journey.action}
          </a>
        ) : (
          <Link className="design-button" href={journey.href}>
            {journey.action}
          </Link>
        )}
      </div>
      <section className="design-documents" aria-label="この版から出力できる資料">
        <div>
          <h3>
            デザイン提案PDF <span>{imageReady ? "出力できます" : "画像の保存後"}</span>
          </h3>
          <p>画像案と制作方針をまとめた資料。サイト完成前の方向性の相談に使います。</p>
          {imageReady && (
            <a className="design-button secondary" href={`/ops/designs/${props.design!.id}/pdf`}>
              デザイン提案PDFを開く
            </a>
          )}
        </div>
        <div>
          <h3>
            承認済み提案PDF <span>{proposalReady ? "出力できます" : "サイトのレビュー・承認後"}</span>
          </h3>
          <p>承認したサイトの提案内容を含む営業資料。提案レビューでの承認後に利用できます。</p>
          {proposalReady && (
            <a className="design-button secondary" href={`/ops/proposals/${props.proposal!.id}/pdf`}>
              承認済み提案PDFを開く
            </a>
          )}
        </div>
      </section>
    </section>
  );
}
