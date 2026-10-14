import Link from "next/link";
import type { ReactNode } from "react";
import { logoutAction } from "@/app/(auth)/actions";

/** 運営画面の共通部品（素朴な見た目。外部CSSは使わない） */

export const NAV_ITEMS = [
  { href: "/ops", label: "概要" },
  { href: "/ops/discovery", label: "1. 収集・候補" },
  { href: "/ops/review", label: "2. 診断・レビュー・営業可能化" },
  { href: "/ops/assignments", label: "3. 担当・営業拒否・引き継ぎ" },
  { href: "/ops/contracts", label: "4. 商品条件・契約・入金・報酬" },
  { href: "/ops/delivery", label: "5. 制作・ドメイン希望" },
  { href: "/ops/settings", label: "6. 設定・操作履歴" },
] as const;

export const OPS_CSS = `
.ops { font-family: system-ui, sans-serif; font-size: 14px; color: #222; max-width: 1200px; margin: 0 auto; padding: 8px 16px 48px; }
.ops header { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; border-bottom: 1px solid #ccc; padding-bottom: 8px; margin-bottom: 12px; }
.ops header nav { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.ops a { color: #0645ad; }
.ops table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; }
.ops th, .ops td { border: 1px solid #ddd; padding: 4px 6px; text-align: left; vertical-align: top; }
.ops th { background: #f3f3f3; font-weight: 600; }
.ops form.inline { display: inline-flex; flex-wrap: wrap; gap: 4px; align-items: center; margin: 2px 0; }
.ops form.stack { display: grid; gap: 6px; max-width: 560px; margin: 8px 0 16px; }
.ops form.stack label { display: grid; gap: 2px; }
.ops input, .ops select, .ops textarea, .ops button { font: inherit; padding: 2px 6px; }
.ops button { cursor: pointer; }
.ops .flash { padding: 6px 10px; margin: 8px 0; border: 1px solid; }
.ops .flash.ok { background: #eef8ee; border-color: #7a7; }
.ops .flash.err { background: #fbeeee; border-color: #c77; }
.ops .muted { color: #666; }
.ops .warn { color: #a40; }
.ops pre { white-space: pre-wrap; word-break: break-all; margin: 0; font-size: 12px; max-height: 240px; overflow: auto; background: #fafafa; }
.ops section { margin: 16px 0 24px; }
.ops details { margin: 4px 0; }
`;

export function OpsShell({ userName, children }: { userName: string; children: ReactNode }) {
  return (
    <div className="ops">
      <style>{OPS_CSS}</style>
      <header>
        <strong>SiteOffer 運営</strong>
        <nav>
          {NAV_ITEMS.map((i) => (
            <Link key={i.href} href={i.href}>
              {i.label}
            </Link>
          ))}
        </nav>
        <span className="muted">
          {userName}（運営）
          <form action={logoutAction} className="inline" style={{ marginLeft: 8 }}>
            <button type="submit">ログアウト</button>
          </form>
        </span>
      </header>
      {children}
    </div>
  );
}

type SearchParams = Record<string, string | string[] | undefined>;

export function first(sp: SearchParams, key: string): string | undefined {
  const v = sp[key];
  return Array.isArray(v) ? v[0] : v;
}

/** 処理結果（Server Function からの戻り先の msg / error） */
export function Flash({ searchParams }: { searchParams: SearchParams }) {
  const msg = first(searchParams, "msg");
  const error = first(searchParams, "error");
  return (
    <>
      {msg ? <p className="flash ok">{msg}</p> : null}
      {error ? (
        <p className="flash err" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** 戻り先を Server Function に渡す隠し項目 */
export function ReturnTo({ path }: { path: string }) {
  return <input type="hidden" name="returnTo" value={path} />;
}

export function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}

export function Forbidden() {
  return <p className="flash err">運営だけが閲覧できます。</p>;
}
