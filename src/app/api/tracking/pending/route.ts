import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { detectCarrier, trackUrl } from "@/lib/carriers";
import { FINAL_EVENTS, RUN_EVERY_HOURS, TRACK_EVENTS } from "@/lib/tracking";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Lo consulta el agente de seguimiento. Dice si toca buscar (pasaron 24 h desde la última
// búsqueda exitosa) y qué buques revisar. Si no toca, devuelve la lista vacía: así el
// agente termina enseguida y no gasta nada.
export async function GET(req: Request) {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sin sesión" }, { status: 401 });
  const { data: prof } = await sb.from("profiles").select("role").eq("id", user.id).single();
  if (prof?.role !== "admin" && prof?.role !== "operaciones") return NextResponse.json({ error: "Sin permiso" }, { status: 403 });

  const force = new URL(req.url).searchParams.get("force") === "1";
  const { data: st } = await sb.from("settings").select("value").eq("key", "tracking_last_run").maybeSingle();
  const lastAt: string | null = (st?.value as any)?.at ?? null;
  const hours = lastAt ? (Date.now() - new Date(lastAt).getTime()) / 36e5 : Infinity;
  const due = force || hours >= RUN_EVERY_HOURS;
  if (!due) return NextResponse.json({ due: false, last_run: lastAt, hours_since: Math.round(hours * 10) / 10, items: [] });

  const [ships, events] = await Promise.all([
    sb.from("shipments").select("booking_no, bl_no, mode, voyage:voyages(id, carrier, vessel:vessels(name))"),
    sb.from("v_voyage_last_event").select("voyage_id, event_type, route_progress"),
  ]);
  const lastOf = new Map((events.data ?? []).map((e: any) => [e.voyage_id, e]));
  const byVoyage = new Map<string, any>();
  for (const s of ships.data ?? []) {
    const v: any = Array.isArray(s.voyage) ? s.voyage[0] : s.voyage;
    if (!v) continue;
    const g = byVoyage.get(v.id) ?? { v, numbers: [] as string[], mode: s.mode };
    const num = s.bl_no ?? (s.booking_no?.startsWith("BL ") ? null : s.booking_no);
    if (num && !g.numbers.includes(num)) g.numbers.push(num);
    byVoyage.set(v.id, g);
  }

  const items = [...byVoyage.entries()].flatMap(([voyageId, g]) => {
    const last: any = lastOf.get(voyageId);
    if (last && FINAL_EVENTS.includes(last.event_type)) return []; // ya llegó: no hace falta buscar más
    if (!g.numbers.length) return [];
    const vessel: any = Array.isArray(g.v.vessel) ? g.v.vessel[0] : g.v.vessel;
    const guess = detectCarrier(g.v.carrier, ...g.numbers);
    return [{
      voyage_id: voyageId, vessel: vessel?.name ?? null, carrier: guess.carrier?.name ?? g.v.carrier,
      numbers: g.numbers, mode: g.mode, url: trackUrl(guess.carrier, g.numbers[0]),
      current_event: last?.event_type ?? null, current_progress: last?.route_progress ?? null,
    }];
  });

  return NextResponse.json({
    due: true, last_run: lastAt, items,
    allowed_events: TRACK_EVENTS.map((e) => ({ code: e.code, meaning: e.label, only_container: !e.roro })),
  });
}
