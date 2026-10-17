import { ContentError } from "@siteoffer/core";
import { getDb } from "@/lib/db";
import { parseWorkFilters } from "@/lib/ops/work-filters";
import { getOpsWorkPage } from "@/lib/ops/work-page";
import { privateRead, ReadInputError } from "@/lib/private-read";

export async function GET(request: Request) {
  return privateRead(["ops"], async (actor) => {
    const filters = parseWorkFilters(new URL(request.url).searchParams);
    if (!filters) throw new ReadInputError("仕事の検索条件を確認してください。");
    const result = await getOpsWorkPage(getDb(), actor, filters);
    if (!result.ok) throw new ContentError("有効な運営権限が必要です。");
    return result.value;
  });
}
