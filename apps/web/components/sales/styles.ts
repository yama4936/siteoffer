/** 営業画面の素朴なスタイル（外部CSSフレームワーク・CDNは使わない）。PC・スマホで崩れない程度 */
export const SALES_CSS = `
.sales { font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; line-height: 1.6; color: #1f2328; max-width: 960px; margin: 0 auto; padding: 0 12px 48px; }
.sales header.top { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between; border-bottom: 1px solid #d0d7de; padding: 12px 0; margin-bottom: 16px; }
.sales header.top nav { display: flex; flex-wrap: wrap; gap: 4px 16px; }
.sales a { color: #0b5cad; }
.sales h1 { font-size: 1.4rem; margin: 8px 0 12px; }
.sales h2 { font-size: 1.15rem; margin: 24px 0 8px; border-left: 4px solid #8c959f; padding-left: 8px; }
.sales section { margin-bottom: 16px; }
.sales .sub { color: #57606a; font-size: 0.9em; }
.sales .notice, .sales .hint { color: #57606a; font-size: 0.9em; margin: 4px 0; }
.sales .warn { background: #fff8c5; border: 1px solid #d4a72c; padding: 8px 10px; border-radius: 4px; }
.sales .disclaimer { background: #f6f8fa; border: 1px solid #d0d7de; padding: 8px 10px; border-radius: 4px; font-size: 0.9em; }
.sales .stack > * + * { margin-top: 8px; }
.sales label { display: block; }
.sales label.inline { display: flex; gap: 6px; align-items: flex-start; }
.sales input:not([type=checkbox]):not([type=radio]), .sales select, .sales textarea { display: block; width: 100%; max-width: 32rem; box-sizing: border-box; padding: 6px 8px; font: inherit; border: 1px solid #8c959f; border-radius: 4px; }
.sales fieldset { border: 1px solid #d0d7de; border-radius: 4px; padding: 8px 12px; }
.sales button { font: inherit; padding: 6px 14px; border: 1px solid #8c959f; border-radius: 4px; background: #f6f8fa; cursor: pointer; }
.sales button.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
.sales button:disabled { opacity: 0.6; cursor: default; }
.sales .msg { margin-top: 8px; padding: 6px 10px; border-radius: 4px; }
.sales .msg-ok { background: #dafbe1; border: 1px solid #4ac26b; }
.sales .msg-error { background: #ffebe9; border: 1px solid #ff8182; }
.sales .msg p { margin: 2px 0; }
.sales .badges { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.sales .badge { display: inline-block; font-size: 0.8em; padding: 0 6px; border-radius: 10px; border: 1px solid #8c959f; white-space: nowrap; }
.sales .badge-mine { background: #ddf4ff; border-color: #54aeff; }
.sales .badge-other { background: #eaeef2; }
.sales .badge-free { background: #dafbe1; border-color: #4ac26b; }
.sales .badge-stop { background: #ffebe9; border-color: #ff8182; }
.sales .badge-guess { background: #fff8c5; border-color: #d4a72c; }
.sales .badge-fact { background: #ddf4ff; border-color: #54aeff; }
.sales .table-wrap { overflow-x: auto; }
.sales table { border-collapse: collapse; width: 100%; font-size: 0.95em; }
.sales th, .sales td { border-bottom: 1px solid #d0d7de; padding: 6px 8px; text-align: left; vertical-align: top; }
.sales th { background: #f6f8fa; white-space: nowrap; }
.sales .filters { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: flex-end; }
.sales .filters label { min-width: 10rem; flex: 1 1 10rem; }
.sales .cards { list-style: none; padding: 0; display: grid; gap: 8px; }
.sales .cards > li { border: 1px solid #d0d7de; border-radius: 6px; padding: 10px 12px; }
.sales .findings { list-style: none; padding: 0; }
.sales .findings > li { border: 1px solid #d0d7de; border-radius: 6px; padding: 8px 12px; margin-bottom: 8px; }
.sales .findings > li.critical { border-color: #ff8182; }
.sales .finding-head { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; }
.sales .help { display: block; color: #57606a; }
.sales dl.kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; }
.sales dl.kv dt { color: #57606a; }
.sales dl.kv dd { margin: 0; overflow-wrap: anywhere; }
.sales .totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 8px; }
.sales .totals div { border: 1px solid #d0d7de; border-radius: 6px; padding: 8px 12px; }
.sales .totals strong { display: block; font-size: 1.2em; }
.sales .markdown { overflow-wrap: anywhere; }
.sales .markdown h2 { font-size: 1.25rem; }
.sales .markdown h3 { font-size: 1.1rem; margin: 20px 0 8px; border-left: 4px solid #8c959f; padding-left: 8px; }
.sales .markdown h4, .sales .markdown h5, .sales .markdown h6 { font-size: 1rem; margin: 16px 0 6px; }
.sales .markdown th { white-space: normal; }
.sales .markdown blockquote { margin: 8px 0; padding: 4px 12px; border-left: 4px solid #d4a72c; background: #fff8c5; }
.sales .markdown pre { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 4px; padding: 8px 10px; overflow-x: auto; white-space: pre-wrap; }
.sales .markdown code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
@media (max-width: 600px) {
  .sales dl.kv { grid-template-columns: 1fr; }
  .sales dl.kv dd { margin-bottom: 6px; }
}
`;
