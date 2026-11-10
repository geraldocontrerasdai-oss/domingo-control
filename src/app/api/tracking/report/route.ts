import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { TRACK_EVENTS } from "@/lib/tracking";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Recibe lo que el agente leyó en las páginas de las navieras. Todo se valida aquí:
// solo eventos de la lista, solo viajes que existen y valores dentro de rango.
// - vessel: si la naviera dice que el mismo booking/BL ahora va en OTRO buque, se actualiza el nombre.
// - occurred_at (AAAA-MM-DD): fecha real del evento según la naviera (sirve para los 25 días de descargados).
// - vehicles: estado por chasis (RORO), ajusta la etapa de cada vehículo.
const DAY = /^\d{4}-\d{2}-\d{2}$/;

async function switchVessel(sb: any, voyageId: string, name: string): Promise<string | null> {
  const clean = name.trim().replace(/\s+/g, " ").slice(0, 80);
  if (clean.length < 2) return null;
  const { data: voy } = await sb.from("voyages").select("id, voyage_no, vessel:vessels(id, name)").eq("id", voyageId).single();
  const cur: any = Array.isArray(voy?.vessel) ? voy.vessel[0] : voy?.vessel;
  if (!voy || cur?.name?.trim().toLowerCase() === clean.toLowerCase()) return null;
  const { data: found } = await sb.from("vessels").select("id").ilike("name", clean).limit(1);
  let vesselId = found?.[0]?.id as string | undefined;
  if (!vesselId) {
    const ins = await sb.from("vessels").insert({ name: clean }).select("id").single();
    if (ins.error) return ins.error.message;
    vesselId = ins.data.id;
  }
  const up = await sb.from("voyages").update({ vessel_id: vesselId }).eq("id", voyageId);
  return up.error ? up.error.message : null;
}

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
  const { data: lastEv } = await sb.from("v_voyage_last_event").select("voyage_id, event_type, route_progress, occurred_at");
  const lastOf = new Map((lastEv ?? []).map((e: any) => [e.voyage_id, e]));

  let applied = 0;
  const skipped: string[] = [];
  const notes: string[] = [];
  for (const u of updates) {
    if (!known.has(u?.voyage_id)) { skipped.push(String(u?.voyage_id ?? "?")); continue; }

    if (typeof u.vessel === "string") {
      const err = await switchVessel(sb, u.voyage_id, u.vessel);
      if (err) notes.push(`buque: ${err}`);
    }

    const ev = TRACK_EVENTS.find((e) => e.code === u?.event_type);
    if (!ev) { if (!u.vessel) skipped.push(`${u.voyage_id} evento inválido`); continue; }
    const occurred = typeof u.occurred_at === "string" && DAY.test(u.occurred_at) ? u.occurred_at : null;
    const prev: any = lastOf.get(u.voyage_id);
    const given = typeof u.route_progress === "number" && u.route_progress >= 0 && u.route_progress <= 1 ? u.route_progress : null;
    // La posición nunca retrocede mientras el buque siga en ruta
    const progress = Math.max(given ?? ev.progress, Number(prev?.route_progress ?? 0) * (ev.progress >= 1 ? 0 : 1));

    if (prev?.event_type === ev.code && Math.abs(Number(prev.route_progress ?? 0) - progress) < 0.005) {
      // Mismo evento ya registrado: solo se corrige la fecha real si antes no la tenía
      if (occurred && !prev.occurred_at) {
        const { data: row } = await sb.from("tracking_events").select("id").eq("voyage_id", u.voyage_id).eq("event_type", ev.code).order("observed_at", { ascending: false }).limit(1);
        if (row?.[0]) { await sb.from("tracking_events").update({ occurred_at: occurred }).eq("id", row[0].id); applied++; continue; }
      }
      skipped.push(`${u.voyage_id} sin cambios`); continue;
    }

    const a = await sb.from("tracking_events").insert({
      voyage_id: u.voyage_id, event_type: ev.code, source: "carrier_web", route_progress: Math.min(progress, 1),
      location: typeof u.location === "string" ? u.location.slice(0, 120) : null, occurred_at: occurred,
    });
    if (a.error) { skipped.push(a.error.message); continue; }
    if (typeof u.eta === "string" && DAY.test(u.eta)) {
      await sb.from("eta_observations").insert({ voyage_id: u.voyage_id, eta: u.eta, source: "carrier_site" });
    }
    const { data: ships } = await sb.from("shipments").select("id").eq("voyage_id", u.voyage_id);
    const ids = (ships ?? []).map((s: any) => s.id);
    if (ids.length) await sb.from("vehicles").update({ stage: ev.stage }).in("shipment_id", ids);
    applied++;
  }

  // Estado por chasis (RORO): cada vehículo toma la etapa de su propio evento
  let vehiclesUpdated = 0;
  const vins: any[] = Array.isArray(body?.vehicles) ? body.vehicles.slice(0, 200) : [];
  for (const c of vins) {
    const ev = TRACK_EVENTS.find((e) => e.code === c?.event_type);
    const vin = typeof c?.vin === "string" ? c.vin.trim().toUpperCase() : "";
    if (!ev || !vin) continue;
    const r = await sb.from("vehicles").update({ stage: ev.stage }).eq("identifier", vin).select("id");
    if (!r.error) vehiclesUpdated += r.data?.length ?? 0;
  }

  // Si todas las búsquedas fallaron (p. ej. la naviera pidió verificación), no cuenta como hecha:
  // el agente vuelve a intentar en el siguiente turno de 3 horas.
  const allFailed = checked > 0 && failed >= checked;
  const errors: string[] = Array.isArray(body?.run?.errors) ? body.run.errors.slice(0, 8).map((e: any) => String(e).slice(0, 160)) : [];
  const nowIso = new Date().toISOString();
  // Reloj por buque: cuenta como leído todo buque con actualización, aunque no haya cambiado, o listado en read_ok.
  const okIds = new Set<string>([...updates.map((u) => u?.voyage_id), ...(Array.isArray(body?.run?.read_ok) ? body.run.read_ok : [])].filter((id) => known.has(id)));
  if (okIds.size) {
    const { data: ck } = await sb.from("settings").select("value").eq("key", "tracking_voyage_checks").maybeSingle();
    const checks: Record<string, string> = { ...((ck?.value as any) ?? {}) };
    for (const id of okIds) checks[id] = nowIso;
    await sb.from("settings").upsert({ key: "tracking_voyage_checks", value: checks });
  }
  if (!allFailed) {
    await sb.from("settings").upsert({ key: "tracking_last_run", value: { at: nowIso, checked, updated: applied, failed, errors } });
  }
  return NextResponse.json({ applied, vehicles_updated: vehiclesUpdated, skipped, notes, counted: !allFailed, voyages_ok: okIds.size });
}
