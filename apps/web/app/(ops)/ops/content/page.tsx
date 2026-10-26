import { ContentWorkspacePage } from "@/components/ops/content-workspace-page";
import { requireUser } from "@/lib/session";
import "../designs/studio.css";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("ops");
  return <ContentWorkspacePage actor={user.actor} audience="ops" search={await searchParams} />;
}
