import { parseProposalImageSnapshot } from "@siteoffer/core";
import { comparisonInputBounded, proposalDisplayGroups } from "@/lib/ops/proposal-display-fields";

/** Server-rendered slot: the browser receives the document, not the raw generation metadata. */
export function ProposalDocument({ content }: { content: unknown }) {
  const groups = proposalDisplayGroups(content);
  const raw =
    content && typeof content === "object" && !Array.isArray(content) ? (content as Record<string, unknown>) : {};
  const images = comparisonInputBounded(raw.demoImageAssets) ? parseProposalImageSnapshot(raw.demoImageAssets) : null;
  return (
    <div className="review-document review-full-document">
      <h3>この提案版の資料・掲載原稿</h3>
      <p>提案、電話台本、想定問答、サイトの文章・設定を確認できます。未設定の項目は省いています。</p>
      {[...groups]
        .sort((a, b) => Number(a.id === "site") - Number(b.id === "site"))
        .map((group) => (
          <details className="review-full-section" open={group.id === "proposal"} key={group.id}>
            <summary>{group.title}</summary>
            {group.unavailable ? (
              <p className="review-full-message">
                保存された資料を読み取れません。制作履歴と元の資料を確認してください。
              </p>
            ) : (
              <dl className="review-full-fields">
                {group.fields
                  .filter((f) => f.value)
                  .map((f) => (
                    <div className="review-full-field" key={f.key}>
                      <dt>{f.label}</dt>
                      <dd>{f.value}</dd>
                    </div>
                  ))}
              </dl>
            )}
          </details>
        ))}
      <details className="review-full-section">
        <summary>この版の掲載写真・ロゴ</summary>
        {images === null ? (
          <p className="review-full-message">保存された素材の記録を読み取れません。</p>
        ) : images.length ? (
          <dl className="review-full-fields">
            {images.map((image) => (
              <div className="review-full-field" key={image.slot}>
                <dt>{image.slot === "hero" ? "メイン写真" : "ロゴ"}</dt>
                <dd>{image.label}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="review-full-message">掲載素材の登録はありません。</p>
        )}
      </details>
    </div>
  );
}
