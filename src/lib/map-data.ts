import { createClient } from "@/lib/supabase/server";
import { detectCarrier, trackUrl } from "@/lib/carriers";
import { buildRoute, needsPanama, originPort, PORT_LABELS, portPoint } from "@/lib/geo";

export type VehicleCard = {
  id: string; identifier: string; title: string; color: string | null; origin: string | null;
  stage: string; docs: string; notes: string | null; provisional: boolean;
  shipmentId: string | null; booking: string; container: string | null; bl: string | null; blStatus: string; consignee: string;
  photo: string | null; // foto principal (URL firmada temporal)
  supplier?: string | null;
};

export type ShipView = {
  id: string; num: string; name: string; voyage: string; mode: "roro" | "container"; carrier: string;
  event: string; eventAt: string | null; eta: string | null; etaSource: string | null;
  trackUrl: string | null; trackNumber: string | null; shipmentIds: string[]; route: string; color: string; done: string; todo: string;
  pos: { x: number; y: number }; tag: { x: number; y: number }; vehicles: VehicleCard[];
};

// Viaje ya descargado hace más de 25 días: sale del mapa y pasa a "Contenedores anteriores"
export type PrevShip = {
  id: string; name: string; carrier: string; mode: "roro" | "container"; route: string;
  event: string; doneAt: string | null; trackNumber: string | null; vehicles: VehicleCard[];
};

// Vehículos comprados que aún no tienen embarque: se muestran en su puerto de origen
export type OriginView = { id: string; name: string; pos: { x: number; y: number }; vehicles: VehicleCard[] };

export const KEEP_DAYS = 25;

export type MapData = { ships: ShipView[]; previous: PrevShip[]; origins: OriginView[]; unassigned: number; role: string; lastRun: string | null; ports: typeof PORT_LABELS };

const FINAL = ["arrived", "discharged"];
const COLORS = ["#7dd3fc", "#86efac", "#fde68a", "#f9a8d4", "#c4b5fd", "#fca5a5"];
const RORO_COLOR = "#fdba74";

const EVENTS: Record<string, string> = {
  booked: "Con reserva", loading_origin: "Cargando en origen", departed: "Zarpó de origen",
  in_transit: "En tránsito", panama: "Cruzando el Canal de Panamá", caribbean: "Navegando el Caribe",
  arrived: "Arribó a destino", discharged: "Descargado",
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function getMapData(): Promise<MapData> {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  const [prof, ships, vehicles, media, events, etas, run] = await Promise.all([
    sb.from("profiles").select("role").eq("id", user!.id).single(),
    sb.from("shipments").select("id, mode, booking_no, bl_no, bl_status, consignee, port_loading, port_discharge, voyage:voyages(id, voyage_no, carrier, vessel:vessels(name)), containers(container_no)"),
    sb.from("vehicles").select("id, identifier, make, model, model_year, color, origin_place, stage, docs, notes, is_provisional, shipment_id, container_id, supplier:suppliers(name)").is("archived_at", null),
    sb.from("vehicle_media").select("vehicle_id, storage_path").eq("is_primary", true).is("archived_at", null),
    sb.from("v_voyage_last_event").select("*"),
    sb.from("v_current_eta").select("voyage_id, eta, source"),
    sb.from("settings").select("value").eq("key", "tracking_last_run").maybeSingle(),
  ]);

  // Fotos principales: URLs firmadas de 1 hora (el bucket es privado)
  const paths = (media.data ?? []).map((m: any) => m.storage_path);
  const signed = paths.length ? (await sb.storage.from("vehicle-media").createSignedUrls(paths, 3600)).data ?? [] : [];
  const urlByPath = new Map(signed.map((s: any) => [s.path, s.signedUrl]));
  const photoOf = new Map((media.data ?? []).map((m: any) => [m.vehicle_id, urlByPath.get(m.storage_path) ?? null]));

  const eventOf = new Map((events.data ?? []).map((e: any) => [e.voyage_id, e]));
  const etaOf = new Map((etas.data ?? []).map((e: any) => [e.voyage_id, e]));

  // Un buque en el mapa = un viaje (varios bookings pueden compartirlo)
  const byVoyage = new Map<string, any[]>();
  for (const s of ships.data ?? []) {
    const v: any = Array.isArray(s.voyage) ? s.voyage[0] : s.voyage;
    if (!v) continue;
    byVoyage.set(v.id, [...(byVoyage.get(v.id) ?? []), s]);
  }

  const groups = [...byVoyage.entries()].map(([voyageId, list]) => {
    const first = list[0];
    const v: any = Array.isArray(first.voyage) ? first.voyage[0] : first.voyage;
    const vessel: any = Array.isArray(v.vessel) ? v.vessel[0] : v.vessel;
    return { voyageId, list, first, v, name: vessel?.name ?? "Buque por confirmar" };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const routeCount = new Map<string, number>();
  let containerNum = 0, roroNum = 0;
  const views: ShipView[] = [];
  const previous: PrevShip[] = [];

  for (const g of groups) {
    const { first, list, v } = g;
    const origin = portPoint(first.port_loading), dest = portPoint(first.port_discharge);
    if (!origin || !dest) continue;
    const roro = first.mode === "roro";
    const evNow: any = eventOf.get(g.voyageId);
    const doneAt: string | null = evNow && FINAL.includes(evNow.event_type) ? (evNow.occurred_at ?? evNow.observed_at) : null;
    const isOld = !!doneAt && Date.now() - new Date(doneAt).getTime() > KEEP_DAYS * 864e5;
    const key = `${first.mode}|${first.port_loading}|${first.port_discharge}`;
    const slot = routeCount.get(key) ?? 0;
    routeCount.set(key, slot + 1);

    const ev: any = eventOf.get(g.voyageId);
    const eta: any = etaOf.get(g.voyageId);
    const geo = buildRoute(origin, dest, needsPanama(first.port_loading), slot, Number(ev?.route_progress ?? 0));
    const shipmentIds = new Set(list.map((s: any) => s.id));
    const shipmentOf = new Map(list.map((s: any) => [s.id, s]));

    const cars: VehicleCard[] = (vehicles.data ?? [])
      .filter((c: any) => shipmentIds.has(c.shipment_id))
      .map((c: any) => {
        const s: any = shipmentOf.get(c.shipment_id);
        const cont = (s.containers ?? []).find((x: any) => x) ?? null;
        return {
          id: c.id, identifier: c.identifier,
          title: [c.model_year, c.make, c.model].filter(Boolean).join(" ") || "Vehículo",
          color: c.color, origin: c.origin_place, stage: c.stage, docs: c.docs, notes: c.notes,
          provisional: c.is_provisional, shipmentId: s.id, booking: s.booking_no, container: cont?.container_no ?? null,
          bl: s.bl_no, blStatus: s.bl_status, consignee: s.consignee, photo: (photoOf.get(c.id) as string) ?? null,
        };
      });

    if (isOld) {
      previous.push({
        id: g.voyageId, name: g.name, carrier: v.carrier, mode: roro ? "roro" : "container",
        route: `${first.port_loading} → ${first.port_discharge}`, event: EVENTS[evNow.event_type] ?? evNow.event_type,
        doneAt, trackNumber: first.bl_no ?? first.booking_no ?? null, vehicles: cars,
      });
      continue;
    }

    views.push({
      id: g.voyageId,
      num: roro ? (++roroNum > 1 ? `R${roroNum}` : "R") : String(++containerNum),
      name: g.name, voyage: v.voyage_no, mode: roro ? "roro" : "container", carrier: v.carrier,
      event: ev ? EVENTS[ev.event_type] ?? ev.event_type : "Sin eventos todavía",
      eventAt: ev?.observed_at ?? null, eta: ev && FINAL.includes(ev.event_type) ? null : eta?.eta ?? null, etaSource: eta?.source ?? null, // ya descargado: la ETA no aplica
      trackUrl: trackUrl(detectCarrier(v.carrier, first.bl_no, first.booking_no).carrier, first.booking_no ?? first.bl_no),
      trackNumber: first.booking_no ?? first.bl_no ?? null,
      shipmentIds: [...shipmentIds], route: `${first.port_loading} → ${first.port_discharge}`,
      color: roro ? RORO_COLOR : COLORS[(containerNum - 1) % COLORS.length],
      ...geo, vehicles: cars,
    });
  }

  previous.sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""));
  const onMap = new Set([...views.flatMap((s) => s.vehicles), ...previous.flatMap((s) => s.vehicles)].map((c) => c.id));
  const orphans = (vehicles.data ?? []).filter((c: any) => !onMap.has(c.id) && c.stage !== "arribado"); // los ya recibidos no se muestran "en origen"
  const byPort = new Map<string, OriginView>();
  let unassigned = 0;
  for (const c of orphans as any[]) {
    const port = originPort(c.origin_place);
    if (!port) { unassigned++; continue; }
    const card: VehicleCard = {
      id: c.id, identifier: c.identifier,
      title: [c.model_year, c.make, c.model].filter(Boolean).join(" ") || "Vehículo",
      color: c.color, origin: c.origin_place, stage: c.stage, docs: c.docs, notes: c.notes,
      provisional: c.is_provisional, shipmentId: null, booking: "", container: null,
      bl: null, blStatus: "none", consignee: "", photo: (photoOf.get(c.id) as string) ?? null,
      supplier: (Array.isArray(c.supplier) ? c.supplier[0]?.name : c.supplier?.name) ?? null,
    };
    const g = byPort.get(port.name) ?? { id: port.name, name: port.name, pos: port.pos, vehicles: [] };
    g.vehicles.push(card);
    byPort.set(port.name, g);
  }
  const origins = [...byPort.values()].sort((a, b) => b.vehicles.length - a.vehicles.length);
  return { ships: views, previous, origins, unassigned, role: prof.data?.role ?? "consulta", lastRun: (run.data?.value as any)?.at ?? null, ports: PORT_LABELS };
}
