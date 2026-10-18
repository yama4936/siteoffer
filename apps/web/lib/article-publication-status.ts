export type ArticlePublicationStatus = {
  publicSite: boolean;
  publishedRevision: number | null;
  publicationRevision: number;
  currentRevision: number;
};

export function articlePublicationLabel(state: ArticlePublicationStatus) {
  if (state.publishedRevision === null) return state.publicationRevision > 0 ? "掲載停止" : "未掲載";
  const label = state.publicSite ? "掲載中" : "掲載準備済み";
  return state.publishedRevision === state.currentRevision ? label : `${label}・変更あり`;
}
