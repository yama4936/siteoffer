import { getImageSubmission, listCustomerImages } from "@siteoffer/core";
import { getDb } from "@/lib/db";
import { privateRead, queryPage, queryUuid, queryValue, ReadInputError } from "@/lib/private-read";

export async function GET(request: Request) {
  return privateRead(["customer_user"], async (actor) => {
    const params = new URL(request.url).searchParams,
      kind = queryValue(params, "kind"),
      companyId = queryUuid(params, "company", true)!;
    if (kind === "item") return getImageSubmission(getDb(), actor, companyId, queryUuid(params, "asset", true)!);
    if (kind !== "list") throw new ReadInputError("確認する操作を指定してください。");
    return listCustomerImages(getDb(), actor, companyId, queryPage(params));
  });
}
