import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/telegram";
import { mergeVehicles } from "@/lib/merge";

// Fusionar un duplicado ({keep, drop}), marcar que dos vehículos NO son el mismo ({ignore: [a, b]})
// o confirmar a mano un vehículo antiguo que ya se sabe correcto ({confirm: id}).
export async function POST(req: Request) {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sin sesión" }, { status: 401 });
  const { data: p } = await sb.from("profiles").select("role").eq("id", user.id).single();
  if (p?.role !== "admin" && p?.role !== "operaciones") return NextResponse.json({ error: "Sin permiso" }, { status: 403 });
  const b = await req.json();

  if (b.confirm) {
    const { error } = await sb.from("vehicles").update({ invoice_confirmed_at: new Date().toISOString() }).eq("id", b.confirm);
    return error ? NextResponse.json({ error: error.message }, { status: 400 }) : NextResponse.json({ ok: true });
  }
  if (b.ignore) {
    const key = [...b.ignore].sort().join("|");
    const admin = adminClient();
    const { data } = await admin.from("settings").select("value").eq("key", "dup_ignored").maybeSingle();
    const list = Array.from(new Set([...((data?.value as string[]) ?? []), key]));
    const { error } = await admin.from("settings").upsert({ key: "dup_ignored", value: list });
    return error ? NextResponse.json({ error: error.message }, { status: 400 }) : NextResponse.json({ ok: true });
  }
  if (b.keep && b.drop) {
    const err = await mergeVehicles(sb, b.keep, b.drop);
    return err ? NextResponse.json({ error: err }, { status: 400 }) : NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Petición no válida" }, { status: 400 });
}
