import { ArticleHistoryError, ContentError, loadArticleHistory, loadArticleRevision } from "@siteoffer/core";
import { getDb } from "@/lib/db";
import { getCurrentActor } from "@/lib/session";

const headers = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
};
export async function GET(req: Request, { params }: { params: Promise<{ companyId: string; entryId: string }> }) {
  try {
    const scope = await params,
      query = new URL(req.url).searchParams;
    if ([...query.keys()].some((k) => !["q", "page", "revision"].includes(k) || query.getAll(k).length !== 1))
      throw new ArticleHistoryError("invalid_input");
    const actor = await getCurrentActor();
    if (query.has("revision")) {
      const revision = query.get("revision")!;
      if (query.size !== 1 || !/^[1-9]\d*$/.test(revision)) throw new ArticleHistoryError("invalid_input");
      return Response.json(
        { kind: "revision", result: await loadArticleRevision(getDb(), actor, scope, Number(revision)) },
        { headers },
      );
    }
    const page = query.get("page") ?? "1";
    if (!/^[1-9]\d*$/.test(page)) throw new ArticleHistoryError("invalid_input");
    return Response.json(
      {
        kind: "history",
        result: await loadArticleHistory(getDb(), actor, scope, { page: Number(page), query: query.get("q") ?? "" }),
      },
      { headers },
    );
  } catch (e) {
    const status =
      e instanceof ArticleHistoryError ? (e.code === "not_found" ? 404 : 400) : e instanceof ContentError ? 403 : 503;
    return Response.json(
      {
        message:
          status === 503
            ? "履歴の読み取りに失敗しました。入力は残っています。再試行してください。"
            : "履歴を取得できません。記事・版・利用権限を確認してください。",
      },
      { status, headers },
    );
  }
}
