import { redirect } from "next/navigation";
import AppNav from "@/components/AppNav";
import Bandeja from "@/components/Bandeja";
import { createClient } from "@/lib/supabase/server";

export default async function Page() {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  const { data: p } = await sb.from("profiles").select("role").eq("id", user!.id).single();
  if (p?.role !== "admin" && p?.role !== "operaciones") redirect("/mapa");
  return (<><AppNav role={p.role} /><Bandeja /></>);
}
