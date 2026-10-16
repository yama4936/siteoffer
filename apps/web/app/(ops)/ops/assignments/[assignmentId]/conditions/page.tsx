import Link from "next/link";
import { notFound } from "next/navigation";
import { OfferChanges } from "@/components/offer-changes";
import { PageHeader, Section } from "@/components/ui/page";
import { getDb } from "@/lib/db";
import { getOfferChangeView } from "@/lib/offer-changes";
import { requireUser } from "@/lib/session";
export const metadata = { title: "商談の条件変更 | SiteOffer" };
export default async function ConditionsPage({ params }: { params: Promise<{ assignmentId: string }> }) {
  const user = await requireUser("ops");
  const { assignmentId } = await params;
  const data = await getOfferChangeView(getDb(), user.actor, assignmentId);
  if (!data) notFound();
  return (
    <>
      <Link href={`/ops/assignments?focus=${assignmentId}`} className="text-primary text-sm">
        担当・引き継ぎへ戻る
      </Link>
      <PageHeader
        title={data.companyName}
        description="商談の条件変更：運営から提示し、営業担当の確認後に適用します。"
      />
      <Section title="販売条件・提案版の変更">
        <OfferChanges data={data} viewerRole="ops" />
      </Section>
    </>
  );
}
