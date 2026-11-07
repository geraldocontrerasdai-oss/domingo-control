import { createClient } from "@/lib/supabase/server";

export default async function Mapa() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user!.id).single();
  return (
    <main className="p-8">
      <p className="text-xs tracking-[0.3em] text-white/60">MAPA · {profile?.role ?? "sin rol"}</p>
      <p className="mt-4 text-white/40">Fase 2: aquí va el mapa con los buques.</p>
    </main>
  );
}
