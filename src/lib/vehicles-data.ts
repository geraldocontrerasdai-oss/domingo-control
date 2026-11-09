import { createClient } from "@/lib/supabase/server";
import type { VehicleCard } from "@/lib/map-data";
import { getAlerts, type Priority } from "@/lib/alerts";

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function getVehicles() {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  const [prof, veh, ships, media] = await Promise.all([
    sb.from("profiles").select("role").eq("id", user!.id).single(),
    sb.from("vehicles").select("id, identifier, make, model, model_year, color, origin_place, stage, docs, notes, is_provisional, shipment_id, supplier:suppliers(name)").is("archived_at", null).order("created_at", { ascending: false }),
    sb.from("shipments").select("id, booking_no, bl_no, bl_status, consignee, containers(container_no), voyage:voyages(vessel:vessels(name))"),
    sb.from("vehicle_media").select("vehicle_id, storage_path").eq("is_primary", true).is("archived_at", null),
  ]);
  const paths = (media.data ?? []).map((m: any) => m.storage_path);
  const signed = paths.length ? (await sb.storage.from("vehicle-media").createSignedUrls(paths, 3600)).data ?? [] : [];
  const urlOf = new Map(signed.map((s: any) => [s.path, s.signedUrl]));
  const photoOf = new Map((media.data ?? []).map((m: any) => [m.vehicle_id, urlOf.get(m.storage_path) ?? null]));
  const shipOf = new Map((ships.data ?? []).map((s: any) => [s.id, s]));

  // Alertas por vehículo: se muestra la más grave y cuántas tiene
  const { items } = await getAlerts();
  const rank: Record<Priority, number> = { alta: 0, media: 1, baja: 2 };
  const alertOf = new Map<string, { worst: Priority; n: number }>();
  const noInv = new Set(items.filter((a) => a.rule === "Sin factura" && a.vehicleId).map((a) => a.vehicleId!));
  for (const a of items) {
    if (!a.vehicleId) continue;
    const cur = alertOf.get(a.vehicleId);
    alertOf.set(a.vehicleId, { worst: !cur || rank[a.priority] < rank[cur.worst] ? a.priority : cur.worst, n: (cur?.n ?? 0) + 1 });
  }

  const cards: (VehicleCard & { vessel: string | null; alert: Priority | null; alertCount: number; noInvoice: boolean; supplier: string | null })[] = (veh.data ?? []).map((c: any) => {
    const s: any = c.shipment_id ? shipOf.get(c.shipment_id) : null;
    const v: any = s ? (Array.isArray(s.voyage) ? s.voyage[0] : s.voyage) : null;
    const vessel: any = v ? (Array.isArray(v.vessel) ? v.vessel[0] : v.vessel) : null;
    return {
      id: c.id, identifier: c.identifier,
      title: [c.model_year, c.make, c.model].filter(Boolean).join(" ") || "Vehículo",
      color: c.color, origin: c.origin_place, stage: c.stage, docs: c.docs, notes: c.notes, provisional: c.is_provisional,
      shipmentId: s?.id ?? null, booking: s?.booking_no ?? "Sin booking", container: s?.containers?.[0]?.container_no ?? null,
      bl: s?.bl_no ?? null, blStatus: s?.bl_status ?? "none", consignee: s?.consignee ?? "Domingo Auto Import SRL",
      photo: (photoOf.get(c.id) as string) ?? null, vessel: vessel?.name ?? null,
      noInvoice: noInv.has(c.id), supplier: (Array.isArray(c.supplier) ? c.supplier[0]?.name : c.supplier?.name) ?? null, alert: alertOf.get(c.id)?.worst ?? null, alertCount: alertOf.get(c.id)?.n ?? 0,
    };
  });
  return { cards, role: prof.data?.role ?? "consulta" };
}
