import type { SupabaseClient } from "@supabase/supabase-js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Fusiona un vehículo duplicado en el correcto: pasa fotos, documentos y guías al correcto, completa sus datos vacíos
// y archiva el duplicado liberando su chasis (nunca se borra nada). Funciona con cualquier cliente con permisos de operaciones.
export async function mergeVehicles(sb: SupabaseClient, keepId: string, dropId: string): Promise<string | null> {
  if (keepId === dropId) return "Son el mismo registro";
  const { data: both } = await sb.from("vehicles").select("*").in("id", [keepId, dropId]);
  const keep: any = both?.find((v: any) => v.id === keepId), drop: any = both?.find((v: any) => v.id === dropId);
  if (!keep || !drop) return "No encontré uno de los dos vehículos";

  // Fotos: la principal del duplicado deja de serlo (el correcto conserva la suya)
  await sb.from("vehicle_media").update({ is_primary: false }).eq("vehicle_id", dropId).eq("is_primary", true);
  const m = await sb.from("vehicle_media").update({ vehicle_id: keepId }).eq("vehicle_id", dropId);
  if (m.error) return m.error.message;
  const d = await sb.from("documents").update({ vehicle_id: keepId }).eq("vehicle_id", dropId);
  if (d.error) return d.error.message;
  const cv = await sb.from("courier_vehicles").select("courier_id").eq("vehicle_id", dropId);
  if (cv.data?.length) await sb.from("courier_vehicles").upsert(cv.data.map((c: any) => ({ courier_id: c.courier_id, vehicle_id: keepId })), { onConflict: "courier_id,vehicle_id", ignoreDuplicates: true });

  // Datos que el correcto no tenía
  const patch: Record<string, unknown> = {};
  for (const f of ["make", "model", "model_year", "color", "origin_place", "shipment_id", "container_id", "supplier_id"]) if (keep[f] == null && drop[f] != null) patch[f] = drop[f];
  if (!keep.invoice_confirmed_at && drop.invoice_confirmed_at) patch.invoice_confirmed_at = drop.invoice_confirmed_at;
  if (Object.keys(patch).length) await sb.from("vehicles").update(patch).eq("id", keepId);

  // El duplicado se archiva y su chasis queda libre para no estorbar después
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[^A-Z0-9]/g, "X");
  const a = await sb.from("vehicles").update({
    archived_at: new Date().toISOString(), identifier: `DUP${tag}${drop.identifier}`.slice(0, 40), id_kind: "chassis",
    notes: `Duplicado de ${keep.identifier}, fusionado. Chasis leído: ${drop.identifier}`,
  }).eq("id", dropId);
  return a.error ? a.error.message : null;
}
