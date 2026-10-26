import { ActivityHistoryError, readActivityHistory } from "@/lib/activity-history";
import { parseActivityHistoryQuery } from "@/lib/activity-history-types";
import { getDb } from "@/lib/db";
import { getCurrentActor } from "@/lib/session";

const headers = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
};
export async function GET(req: Request, { params }: { params: Promise<{ assignmentId: string }> }) {
  try {
    const search = new URL(req.url).searchParams;
    if (
      [...search.keys()].some(
        (k) => !["page", "q", "kind", "consultations"].includes(k) || search.getAll(k).length !== 1,
      )
    )
      throw new ActivityHistoryError("invalid_input");
    const filters = parseActivityHistoryQuery(Object.fromEntries(search));
    if (!filters) throw new ActivityHistoryError("invalid_input");
    return Response.json(
      {
        ok: true,
        result: await readActivityHistory(getDb(), await getCurrentActor(), (await params).assignmentId, filters),
      },
      { headers },
    );
  } catch (error) {
    const status =
      error instanceof ActivityHistoryError
        ? ({ invalid_input: 400, forbidden: 403, not_found: 404 } as const)[error.code]
        : 503;
    return Response.json(
      {
        ok: false,
        message:
          status === 503
            ? "活動履歴を読み取れません。入力中のメモは残っています。再試行してください。"
            : "案件・検索条件・利用権限を確認してください。",
      },
      { status, headers },
    );
  }
}
