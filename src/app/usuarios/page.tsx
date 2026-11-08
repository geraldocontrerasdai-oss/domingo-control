import { redirect } from "next/navigation";
import AppNav from "@/components/AppNav";
import UsersAdmin from "@/components/UsersAdmin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function Page() {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  const { data: p } = await sb.from("profiles").select("role").eq("id", user!.id).single();
  if (p?.role !== "admin") redirect("/mapa");
  return (<><AppNav role={p.role} /><UsersAdmin /></>);
}
