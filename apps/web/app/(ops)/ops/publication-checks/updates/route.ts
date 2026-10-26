import { getPublicationMaterial, listPublicationMaterials } from "@siteoffer/core";
import { getDb } from "@/lib/db";
import { privateRead, queryPage, queryUuid, queryValue, ReadInputError } from "@/lib/private-read";

export async function GET(request: Request) {
  return privateRead(["ops"], async (actor) => {
    const params = new URL(request.url).searchParams,
      kind = queryValue(params, "kind");
    if (kind === "item") return getPublicationMaterial(getDb(), actor, queryUuid(params, "deployment", true)!);
    if (kind !== "list") throw new ReadInputError("確認する操作を指定してください。");
    const mode = queryValue(params, "mode");
    if (mode !== "pending" && mode !== "resolved" && mode !== "all")
      throw new ReadInputError("確認状況の条件を指定してください。");
    return listPublicationMaterials(getDb(), actor, {
      companyId: queryUuid(params, "company"),
      deliveryId: queryUuid(params, "delivery"),
      deploymentId: queryUuid(params, "deployment"),
      page: queryPage(params),
      mode,
    });
  });
}
