import { redirect } from "next/navigation";
import { homePathFor } from "@/lib/home";
import { getCurrentUser } from "@/lib/session";

/** 入口。未ログインはログインへ、営業は企業一覧へ、運営は運営の概要へ移る */
export default async function Home() {
  const user = await getCurrentUser();
  redirect(user ? homePathFor(user.role) : "/login");
}
