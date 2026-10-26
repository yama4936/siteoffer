import { countPendingImageSubmissions, getImageSubmission, listImageSubmissionsForOps } from "@siteoffer/core";
import { getDb } from "@/lib/db";
import { privateRead, queryPage, queryUuid, queryValue, ReadInputError } from "@/lib/private-read";

export async function GET(request: Request) {
  return privateRead(["ops"], async (actor) => {
    const params = new URL(request.url).searchParams,
      kind = queryValue(params, "kind");
    if (kind === "count") return countPendingImageSubmissions(getDb(), actor);
    if (kind === "item")
      return getImageSubmission(getDb(), actor, queryUuid(params, "company", true)!, queryUuid(params, "asset", true)!);
    if (kind !== "list") throw new ReadInputError("確認する操作を指定してください。");
    const pending = queryValue(params, "pending");
    if (pending !== "0" && pending !== "1") throw new ReadInputError("確認状況の条件を指定してください。");
    return listImageSubmissionsForOps(getDb(), actor, {
      companyId: queryUuid(params, "company"),
      assetId: queryUuid(params, "asset"),
      page: queryPage(params),
      pendingOnly: pending === "1",
    });
  });
}
