import { ConsultationsPage } from "@/components/consultations-page";
export const metadata = { title: "相談 | SiteOffer" };
export default function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <ConsultationsPage userRole="sales" searchParams={searchParams} />;
}
