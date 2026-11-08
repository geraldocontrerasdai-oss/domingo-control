import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/telegram";

/* eslint-disable @typescript-eslint/no-explicit-any */
const ROLES = ["admin", "operaciones", "consulta"];

async function requireAdmin() {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const { data: p } = await sb.from("profiles").select("role").eq("id", user.id).single();
  return p?.role === "admin" ? user : null;
}
const noKey = () => !process.env.SUPABASE_SERVICE_ROLE_KEY;

// Lista de usuarios con su rol, último ingreso y si tienen el acceso quitado.
export async function GET() {
  const me = await requireAdmin();
  if (!me) return NextResponse.json({ error: "Solo administradores" }, { status: 403 });
  if (noKey()) return NextResponse.json({ error: "Falta SUPABASE_SERVICE_ROLE_KEY" }, { status: 500 });
  const admin = adminClient();
  const [{ data: profs }, { data: au }] = await Promise.all([
    admin.from("profiles").select("id, email, full_name, role, created_at").order("created_at"),
    admin.auth.admin.listUsers({ perPage: 200 }),
  ]);
  const info = new Map((au?.users ?? []).map((u) => [u.id, u]));
  return NextResponse.json({
    me: me.id,
    users: (profs ?? []).map((p: any) => ({ ...p, last: info.get(p.id)?.last_sign_in_at ?? null, blocked: !!info.get(p.id)?.banned_until && new Date(info.get(p.id)!.banned_until!) > new Date() })),
  });
}

// Alta: crea el usuario (sin enviar correo todavía) y su rol. Entra con su correo desde la pantalla de inicio.
export async function POST(req: Request) {
  const me = await requireAdmin();
  if (!me) return NextResponse.json({ error: "Solo administradores" }, { status: 403 });
  if (noKey()) return NextResponse.json({ error: "Falta SUPABASE_SERVICE_ROLE_KEY" }, { status: 500 });
  const b = await req.json();
  const email = String(b.email ?? "").trim().toLowerCase();
  const role = ROLES.includes(b.role) ? b.role : "consulta";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return NextResponse.json({ error: "Correo no válido" }, { status: 400 });
  const admin = adminClient();
  let id: string | undefined;
  const created = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (created.data?.user) id = created.data.user.id;
  else {
    const list = await admin.auth.admin.listUsers({ perPage: 1000 });
    id = list.data?.users.find((u) => u.email?.toLowerCase() === email)?.id;
    if (!id) return NextResponse.json({ error: created.error?.message ?? "No se pudo crear el usuario" }, { status: 400 });
  }
  const { error } = await admin.from("profiles").upsert({ id, email, full_name: String(b.full_name ?? "").trim() || null, role });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}

// Cambiar rol, o quitar / devolver el acceso. Nadie se quita el acceso ni se baja de admin a sí mismo.
export async function PATCH(req: Request) {
  const me = await requireAdmin();
  if (!me) return NextResponse.json({ error: "Solo administradores" }, { status: 403 });
  if (noKey()) return NextResponse.json({ error: "Falta SUPABASE_SERVICE_ROLE_KEY" }, { status: 500 });
  const b = await req.json();
  if (!b.id) return NextResponse.json({ error: "Falta el usuario" }, { status: 400 });
  if (b.id === me.id) return NextResponse.json({ error: "No puedes cambiar tu propio acceso o rol." }, { status: 400 });
  const admin = adminClient();
  if (b.role) {
    if (!ROLES.includes(b.role)) return NextResponse.json({ error: "Rol no válido" }, { status: 400 });
    const { error } = await admin.from("profiles").update({ role: b.role }).eq("id", b.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (typeof b.blocked === "boolean") {
    const { error } = await admin.auth.admin.updateUserById(b.id, { ban_duration: b.blocked ? "876000h" : "none" });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
