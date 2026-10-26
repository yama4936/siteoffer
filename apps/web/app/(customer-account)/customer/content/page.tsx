import { ContentWorkspacePage } from "@/components/ops/content-workspace-page";
import { requireUser } from "@/lib/session";
import "@/app/(ops)/ops/designs/studio.css";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("customer");
  return <ContentWorkspacePage actor={user.actor} audience="customer" search={await searchParams} />;
}
