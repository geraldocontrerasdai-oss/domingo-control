import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { detectCarrier, searchNumber, trackUrl } from "@/lib/carriers";
import { FINAL_EVENTS, RUN_EVERY_HOURS, TRACK_EVENTS } from "@/lib/tracking";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Lo consulta el agente de seguimiento. Dice qué buques toca revisar (los que llevan 48 h o más sin una
// lectura buena; los que fallaron se reintentan en la siguiente vuelta de 3 h). Si no toca, devuelve la lista vacía: así el
// agente termina enseguida y no gasta nada.
export async function GET(req: Request) {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sin sesión" }, { status: 401 });
  const { data: prof } = await sb.from("profiles").select("role").eq("id", user.id).single();
  if (prof?.role !== "admin" && prof?.role !== "operaciones") return NextResponse.json({ error: "Sin permiso" }, { status: 403 });

  // Cada buque tiene su propio reloj: se vuelve a buscar cuando pasaron 48 h desde SU última lectura buena (RUN_EVERY_HOURS).
  // Así, si una naviera falla, solo esa se reintenta en la próxima vuelta de 3 h y las demás no se repiten.
  const force = new URL(req.url).searchParams.get("force") === "1";
  const [{ data: st }, { data: ck }] = await Promise.all([
    sb.from("settings").select("value").eq("key", "tracking_last_run").maybeSingle(),
    sb.from("settings").select("value").eq("key", "tracking_voyage_checks").maybeSingle(),
  ]);
  const lastAt: string | null = (st?.value as any)?.at ?? null;
  const checks: Record<string, string> = (ck?.value as any) ?? {};
  const staleHours = (voyageId: string) => { const t = checks[voyageId]; return t ? (Date.now() - new Date(t).getTime()) / 36e5 : Infinity; };

  const [ships, events, cars] = await Promise.all([
    sb.from("shipments").select("id, booking_no, bl_no, mode, voyage:voyages(id, carrier, vessel:vessels(name))"),
    sb.from("v_voyage_last_event").select("voyage_id, event_type, route_progress"),
    sb.from("vehicles").select("identifier, shipment_id").is("archived_at", null),
  ]);
  const lastOf = new Map((events.data ?? []).map((e: any) => [e.voyage_id, e]));
  const byVoyage = new Map<string, any>();
  for (const s of ships.data ?? []) {
    const v: any = Array.isArray(s.voyage) ? s.voyage[0] : s.voyage;
    if (!v) continue;
    const g = byVoyage.get(v.id) ?? { v, numbers: [] as string[], mode: s.mode, vehicles: [] as { vin: string; booking: string }[] };
    for (const c of cars.data ?? []) if (c.shipment_id === s.id) g.vehicles.push({ vin: c.identifier, booking: s.booking_no });
    const num = s.bl_no ?? (s.booking_no?.startsWith("BL ") ? null : s.booking_no);
    if (num && !g.numbers.includes(num)) g.numbers.push(num);
    byVoyage.set(v.id, g);
  }

  const items = [...byVoyage.entries()].flatMap(([voyageId, g]) => {
    const last: any = lastOf.get(voyageId);
    if (last && FINAL_EVENTS.includes(last.event_type)) return []; // ya llegó: no hace falta buscar más
    if (!g.numbers.length) return [];
    if (!force && staleHours(voyageId) < RUN_EVERY_HOURS) return []; // leído hace menos de 48 h
    const vessel: any = Array.isArray(g.v.vessel) ? g.v.vessel[0] : g.v.vessel;
    const guess = detectCarrier(g.v.carrier, ...g.numbers);
    const numbers = g.numbers.map((n: string) => searchNumber(guess.carrier, n));
    return [{
      voyage_id: voyageId, vessel: vessel?.name ?? null, carrier: guess.carrier?.name ?? g.v.carrier,
      numbers, hours_since_ok: Number.isFinite(staleHours(voyageId)) ? Math.round(staleHours(voyageId)) : null, vehicles: g.mode === "roro" ? g.vehicles : undefined, mode: g.mode, url: trackUrl(guess.carrier, numbers[0]), url_has_number: guess.carrier?.code === "ONE" || guess.carrier?.code === "MAEU",
      current_event: last?.event_type ?? null, current_progress: last?.route_progress ?? null,
    }];
  });

  if (!items.length) return NextResponse.json({ due: false, last_run: lastAt, items: [] });
  return NextResponse.json({
    due: true, last_run: lastAt, items,
    allowed_events: TRACK_EVENTS.map((e) => ({ code: e.code, meaning: e.label, only_container: !e.roro })),
  });
}
