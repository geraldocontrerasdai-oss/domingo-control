import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeVin } from "@/lib/vin";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type VRow = { id: string; identifier: string; make: string | null; model: string | null; model_year: number | null; shipment_id: string | null; origin?: string | null; invoice_confirmed_at?: string | null };
export type Match = { row: VRow; tier: "same_tail" | "near"; why: string };

export const label = (v: Pick<VRow, "make" | "model" | "model_year">) => [v.model_year, v.make, v.model].filter(Boolean).join(" ") || "Vehículo";
const skel = (s: string) => normalizeVin(s).replace(/Q/g, "0").replace(/I/g, "1");
const ham = (a: string, b: string) => (a.length !== b.length ? 99 : [...a].reduce((n, c, i) => n + (c !== b[i] ? 1 : 0), 0));
const sameMake = (a?: string | null, b?: string | null) => !a || !b || a.trim().toLowerCase().split(/\s+/)[0] === b.trim().toLowerCase().split(/\s+/)[0];

// Carga los vehículos activos (y funciona aunque la columna de confirmación todavía no exista).
export async function loadIndex(sb: SupabaseClient): Promise<VRow[]> {
  const full = "id, identifier, make, model, model_year, shipment_id, origin, invoice_confirmed_at";
  let r: any = await sb.from("vehicles").select(full).is("archived_at", null).limit(3000);
  if (r.error) r = await sb.from("vehicles").select(full.replace(", invoice_confirmed_at", "")).is("archived_at", null).limit(3000);
  return (r.data ?? []) as unknown as VRow[];
}

/**
 * Compara un chasis que llega en un documento con los que ya existen.
 *  - exact: mismo chasis (la O vale 0, I vale 1 y Q vale 0).
 *  - same_tail: terminan en los mismos 6 caracteres y el resto casi no cambia → casi seguro es el mismo (lectura borrosa).
 *  - near: difieren en 1 o 2 caracteres. Solo se pregunta si el documento NO es una factura o si el existente aún no tiene factura,
 *    porque dos vehículos de la misma serie pueden diferir en pocos dígitos.
 */
export function matchVin(vin: string, rows: VRow[], o: { isInvoice: boolean; make?: string | null }): { exact: VRow | null; similar: Match[] } {
  const v = skel(vin);
  let exact: VRow | null = null;
  const similar: Match[] = [];
  if (!v) return { exact, similar };
  for (const r of rows) {
    const w = skel(r.identifier);
    if (w === v) { exact = r; continue; }
    if (!sameMake(o.make, r.make)) continue;
    if (v.length >= 10 && v.length === w.length) {
      if (v.slice(-6) === w.slice(-6) && ham(v.slice(0, -6), w.slice(0, -6)) <= 4) similar.push({ row: r, tier: "same_tail", why: "terminan igual (los últimos 6)" });
      else if (ham(v, w) <= 2 && (!o.isInvoice || !r.invoice_confirmed_at)) similar.push({ row: r, tier: "near", why: `se diferencian en ${ham(v, w)} carácter(es)` });
    }
  }
  similar.sort((a, b) => (a.tier === b.tier ? 0 : a.tier === "same_tail" ? -1 : 1));
  return { exact, similar: similar.slice(0, 2) };
}

// Parejas ya registradas que parecen el mismo vehículo (mismos 6 últimos y misma marca).
export function findDuplicatePairs(rows: VRow[]): [VRow, VRow][] {
  const out: [VRow, VRow][] = [];
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const a = skel(rows[i].identifier), b = skel(rows[j].identifier);
    if (a.length !== b.length || a.length < 10 || !sameMake(rows[i].make, rows[j].make)) continue;
    if (a.slice(-6) === b.slice(-6) && ham(a.slice(0, -6), b.slice(0, -6)) <= 4) out.push([rows[i], rows[j]]);
  }
  return out;
}
