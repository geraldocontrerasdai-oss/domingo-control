import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { TRACK_EVENTS } from "@/lib/tracking";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Recibe lo que el agente leyó en las páginas de las navieras. Todo se valida aquí:
// solo eventos de la lista, solo viajes que existen y valores dentro de rango.
export async function POST(req: Request) {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sin sesión" }, { status: 401 });
  const { data: prof } = await sb.from("profiles").select("role").eq("id", user.id).single();
  if (prof?.role !== "admin" && prof?.role !== "operaciones") return NextResponse.json({ error: "Sin permiso" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const updates: any[] = Array.isArray(body?.updates) ? body.updates.slice(0, 50) : [];
  const checked = Number(body?.run?.checked ?? updates.length) || 0;
  const failed = Number(body?.run?.failed ?? 0) || 0;

  const { data: voy } = await sb.from("voyages").select("id");
  const known = new Set((voy ?? []).map((v: any) => v.id));
  const { data: lastEv } = await sb.from("v_voyage_last_event").select("voyage_id, event_type, route_progress");
  const lastOf = new Map((lastEv ?? []).map((e: any) => [e.voyage_id, e]));

  let applied = 0;
  const skipped: string[] = [];
  for (const u of updates) {
    const ev = TRACK_EVENTS.find((e) => e.code === u?.event_type);
    if (!known.has(u?.voyage_id) || !ev) { skipped.push(String(u?.voyage_id ?? "?")); continue; }
    const prev: any = lastOf.get(u.voyage_id);
    const given = typeof u.route_progress === "number" && u.route_progress >= 0 && u.route_progress <= 1 ? u.route_progress : null;
    // La posición nunca retrocede mientras el buque siga en ruta
    const progress = Math.max(given ?? ev.progress, Number(prev?.route_progress ?? 0) * (ev.progress >= 1 ? 0 : 1));
    if (prev?.event_type === ev.code && Math.abs(Number(prev.route_progress ?? 0) - progress) < 0.005) { skipped.push(`${u.voyage_id} sin cambios`); continue; }

    const a = await sb.from("tracking_events").insert({
      voyage_id: u.voyage_id, event_type: ev.code, source: "carrier_web", route_progress: Math.min(progress, 1),
      location: typeof u.location === "string" ? u.location.slice(0, 120) : null,
    });
    if (a.error) { skipped.push(a.error.message); continue; }
    if (typeof u.eta === "string" && /^\d{4}-\d{2}-\d{2}$/.test(u.eta)) {
      await sb.from("eta_observations").insert({ voyage_id: u.voyage_id, eta: u.eta, source: "carrier_site" });
    }
    const { data: ships } = await sb.from("shipments").select("id").eq("voyage_id", u.voyage_id);
    const ids = (ships ?? []).map((s: any) => s.id);
    if (ids.length) await sb.from("vehicles").update({ stage: ev.stage }).in("shipment_id", ids);
    applied++;
  }

  // Si todas las búsquedas fallaron (p. ej. la naviera pidió verificación), no cuenta como hecha:
  // el agente vuelve a intentar en el siguiente turno de 3 horas.
  const allFailed = checked > 0 && failed >= checked;
  if (!allFailed) {
    await sb.from("settings").upsert({ key: "tracking_last_run", value: { at: new Date().toISOString(), checked, updated: applied, failed } });
  }
  return NextResponse.json({ applied, skipped, counted: !allFailed });
}
