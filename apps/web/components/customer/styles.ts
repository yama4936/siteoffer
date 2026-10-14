/** 顧客確認の画面の最小限のスタイル（外部の読み込みなし） */
export const customerCss = `
.customer { max-width: 1100px; margin: 0 auto; padding: 16px; font: 16px/1.7 system-ui, sans-serif; color: #1f2328; }
.customer h1 { font-size: 1.5rem; margin: 0 0 8px; }
.customer h2 { font-size: 1.15rem; margin: 24px 0 8px; }
.customer .muted { color: #59636e; font-size: 0.9rem; }
.customer .note { background: #f6f8fa; border: 1px solid #d1d9e0; border-radius: 6px; padding: 12px; }
.customer .preview-frame { width: 100%; height: 70vh; border: 1px solid #d1d9e0; border-radius: 6px; background: #fff; }
.customer .preview-tabs { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
.customer .stack { display: flex; flex-direction: column; gap: 12px; max-width: 640px; }
.customer textarea { width: 100%; min-height: 8em; font: inherit; }
.customer button { font: inherit; padding: 8px 16px; cursor: pointer; }
.customer .primary { background: #0969da; color: #fff; border: 1px solid #0969da; border-radius: 6px; }
.customer .msg { border-radius: 6px; padding: 12px; }
.customer .msg-ok { background: #dafbe1; border: 1px solid #4ac26b; }
.customer .msg-error { background: #ffebe9; border: 1px solid #ff8182; }
@media (max-width: 640px) { .customer .preview-frame { height: 60vh; } }
`;
