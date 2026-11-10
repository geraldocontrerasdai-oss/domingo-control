import { createClient } from "@/lib/supabase/server";
import { buildChecklist, type CourierInfo } from "@/lib/checklist";
import { findDuplicatePairs, label as vlabel } from "@/lib/vin-match";

export type Priority = "alta" | "media" | "baja";
export type AlertItem = {
  id: string; priority: Priority; rule: string; title: string; detail: string; action: string;
  vehicleId?: string; ref?: string; // chasis o buque, para mostrar y buscar
  dup?: { a: { id: string; identifier: string; label: string }; b: { id: string; identifier: string; label: string } };
};
export type AlertsData = { items: AlertItem[]; role: string; lastRun: string | null };

const DAY = 864e5;
const FINAL_EVENTS_SET = new Set(["arrived", "discharged"]);
const days = (iso: string) => (new Date(iso).getTime() - Date.now()) / DAY;
const fmt = (iso: string) => new Date(iso).toLocaleDateString("es-DO", { day: "numeric", month: "short", timeZone: "UTC" });

import { PLAN_ALERT_PCT, SUPABASE_STORAGE_FREE_BYTES } from "@/lib/limits";
/* eslint-disable @typescript-eslint/no-explicit-any */
// Las alertas se calculan en el momento con lo que ya está guardado: no hay tabla que mantener
// ni tarea programada. Cada regla dice qué pasa y qué hacer.
export async function getAlerts(client?: any): Promise<AlertsData> {
  const sb = client ?? (await createClient());
  const { data: { user } } = await sb.auth.getUser();
  const [prof, veh, ships, events, etas, media, run, cour, docsQ, tev, inv, ign] = await Promise.all([
    sb.from("profiles").select("role").eq("id", user!.id).single(),
    sb.from("vehicles").select("id, identifier, make, model, model_year, is_provisional, docs, stage, shipment_id, created_at, origin").is("archived_at", null),
    sb.from("shipments").select("id, booking_no, bl_no, bl_status, voyage_id, voyage:voyages(id, vessel:vessels(name))"),
    sb.from("v_voyage_last_event").select("voyage_id, event_type, occurred_at, observed_at"),
    sb.from("eta_observations").select("voyage_id, eta, observed_at").order("observed_at", { ascending: false }),
    sb.from("vehicle_media").select("vehicle_id").eq("is_primary", true).is("archived_at", null),
    sb.from("settings").select("value").eq("key", "tracking_last_run").maybeSingle(),
    sb.from("courier_vehicles").select("vehicle_id, courier:courier_shipments(kind, carrier, tracking_no, received_confirmed_at)"),
    sb.from("documents").select("vehicle_id, shipment_id, doc_type").eq("is_current", true).is("archived_at", null),
    sb.from("tracking_events").select("voyage_id, event_type, occurred_at, observed_at"),
    sb.from("vehicles").select("id, invoice_confirmed_at").is("archived_at", null), // falla si la columna aún no existe: entonces no hay alertas de factura
    sb.from("settings").select("value").eq("key", "dup_ignored").maybeSingle(),
  ]);
  const invOf = inv.error ? null : new Map((inv.data ?? []).map((x: any) => [x.id, x.invoice_confirmed_at as string | null]));
  const ignored = new Set<string>(((ign.data?.value as string[]) ?? []));
  // Fecha de salida: el evento "zarpó" si existe; si no, el evento más antiguo registrado.
  const depOf = new Map<string, string>();
  for (const e of (tev.data ?? []) as any[]) {
    const t = e.occurred_at ?? e.observed_at; const cur = depOf.get(e.voyage_id);
    const isDep = e.event_type === "departed";
    const curIsDep = cur?.startsWith("D|");
    if (isDep && (!curIsDep || t < cur!.slice(2))) depOf.set(e.voyage_id, "D|" + t);
    else if (!isDep && !curIsDep && (!cur || t < cur)) depOf.set(e.voyage_id, t);
  }
  const courOf = new Map<string, CourierInfo[]>();
  for (const r of (cour.data ?? []) as any[]) {
    const c = Array.isArray(r.courier) ? r.courier[0] : r.courier;
    if (c) courOf.set(r.vehicle_id, [...(courOf.get(r.vehicle_id) ?? []), { kind: c.kind, carrier: c.carrier, tracking_no: c.tracking_no, received: !!c.received_confirmed_at }]);
  }
  const docsOfVeh = new Map<string, Set<string>>();
  const docsOfShip = new Map<string, Set<string>>();
  for (const d of (docsQ.data ?? []) as any[]) {
    const m = d.vehicle_id ? docsOfVeh : docsOfShip; const k = d.vehicle_id ?? d.shipment_id;
    if (k) m.set(k, (m.get(k) ?? new Set()).add(d.doc_type));
  }

  const shipOf = new Map((ships.data ?? []).map((s: any) => [s.id, s]));
  const evOf = new Map((events.data ?? []).map((e: any) => [e.voyage_id, e]));
  const withPhoto = new Set((media.data ?? []).map((m: any) => m.vehicle_id));
  const etaList = new Map<string, any[]>();
  for (const e of etas.data ?? []) etaList.set(e.voyage_id, [...(etaList.get(e.voyage_id) ?? []), e]);

  const name = (v: any) => [v.model_year, v.make, v.model].filter(Boolean).join(" ") || "Vehículo";
  const vesselOf = (s: any) => { const v: any = Array.isArray(s?.voyage) ? s.voyage[0] : s?.voyage; const ve: any = Array.isArray(v?.vessel) ? v.vessel[0] : v?.vessel; return ve?.name ?? "buque"; };
  const items: AlertItem[] = [];
  // Reloj por buque (última lectura buena del seguimiento): a las 36 h sin actualizar avisa, a las 48 h es importante
  const { data: ckRow } = await sb.from("settings").select("value").eq("key", "tracking_voyage_checks").maybeSingle();
  const voyChecks: Record<string, string> = (ckRow?.value as any) ?? {};
  const staleSeen = new Set<string>();

  for (const c of veh.data ?? []) {
    const s: any = c.shipment_id ? shipOf.get(c.shipment_id) : null;
    const base = { vehicleId: c.id, ref: c.identifier };
    const ev: any = s?.voyage_id ? evOf.get(s.voyage_id) : null;
    const eta: string | null = s?.voyage_id ? etaList.get(s.voyage_id)?.[0]?.eta ?? null : null;
    const arrived = ev && ["arrived", "discharged"].includes(ev.event_type);
    const closed = arrived && days(ev.occurred_at ?? ev.observed_at) < -21; // descargado hace más de 3 semanas: ya es historial, sin alertas
    if (closed) continue;
    if (c.stage === "arribado" && !s) continue; // ya recibido en Haina sin pasar por un embarque registrado: sin alertas
    if (s?.voyage_id && !arrived && !staleSeen.has(s.voyage_id) && FINAL_EVENTS_SET.has(ev?.event_type) === false) {
      staleSeen.add(s.voyage_id);
      const lastOk = voyChecks[s.voyage_id] ?? ev?.observed_at ?? null;
      const hrs = lastOk ? -days(lastOk) * 24 : null;
      if (hrs !== null && hrs >= 36) {
        items.push({ ...base, id: `buque-sin-actualizar-${s.voyage_id}`, priority: hrs >= 48 ? "alta" : "media", rule: "Buque sin actualizar", ref: vesselOf(s),
          title: `${vesselOf(s)} lleva ${Math.round(hrs)} horas sin actualizarse`,
          detail: "El seguimiento no logró leer la página de la naviera. Si pasa de 48 horas, hay que revisarlo a mano.",
          action: "Abrir el seguimiento del buque desde el mapa (botón de la naviera) y actualizar el estado a mano; confirmar que la app de Claude esté abierta en la laptop." });
      }
    }
    const blOk = s?.bl_status === "final" || !!s?.booking_no; // con booking no se necesita el BL

    // 1. Se acerca a destino sin BL definitivo
    if (s && !arrived && eta && days(eta) <= 7 && !blOk) {
      items.push({ ...base, id: `bl-llegada-${c.id}`, priority: "alta", rule: "BL antes de llegar",
        title: `${name(c)} llega ${days(eta) <= 0 ? "hoy o ya está por llegar" : `en ${Math.ceil(days(eta))} días`} y el BL no es definitivo`,
        detail: `${vesselOf(s)} · ETA ${fmt(eta)} · BL ${s.bl_status === "draft" ? "en borrador" : "sin BL"}`,
        action: "Pedir el BL definitivo al proveedor y subirlo en la Bandeja." });
    }
    // 3. Zarpó hace tiempo y todavía no hay BL
    if (s && !arrived && !blOk && ev && days(ev.occurred_at ?? ev.observed_at) < -7 && !(eta && days(eta) <= 7)) {
      items.push({ ...base, id: `bl-zarpo-${c.id}`, priority: "media", rule: "BL pendiente",
        title: `${name(c)} lleva más de 7 días en ruta sin BL definitivo`,
        detail: `${vesselOf(s)} · BL ${s.bl_status === "draft" ? "en borrador" : "sin BL"}`,
        action: "Pedir el BL al proveedor o buscarlo en la naviera." });
    }
    // 4. Sin embarque: comprado hace tiempo y sin reserva
    if (!s && days(c.created_at) < -14) {
      items.push({ ...base, id: `sin-reserva-${c.id}`, priority: "media", rule: "Sin reserva",
        title: `${name(c)} lleva más de ${Math.round(-days(c.created_at))} días en origen sin reserva`,
        detail: c.is_provisional ? "Además no tiene chasis asignado." : "Aún no hay booking ni BL.",
        action: "Confirmar con el proveedor la reserva del embarque." });
    }
    // 4b. Documentos originales / título (checklist por origen)
    const types = new Set([...(docsOfVeh.get(c.id) ?? []), ...(c.shipment_id ? docsOfShip.get(c.shipment_id) ?? [] : [])]);
    const list = buildChecklist({ origin: c.origin, blStatus: s?.bl_status ?? "none", hasBooking: !!s?.booking_no, docTypes: types, couriers: courOf.get(c.id) ?? [] });
    if (c.origin === "manheim" && c.stage !== "arribado" && c.stage !== "en_transito" && c.stage !== "embarcado") {
      const t = list.find((i) => i.key === "title")!;
      if (t.state !== "ok") {
        items.push({ ...base, id: `titulo-${c.id}`, priority: s || t.state === "falta" && days(c.created_at) < -5 ? "alta" : "media", rule: "Título pendiente",
          title: `${name(c)} no puede embarcar: falta el título`, detail: t.detail,
          action: t.state === "falta" ? "Pedir a la subasta que envíe el título por FedEx a Florida y registrar la guía." : "Dar seguimiento a la guía y confirmar cuando llegue a Florida." });
      }
    }
    if (c.origin !== "manheim" && s) {
      const o = list.find((i) => i.key === "originals")!;
      const depRaw = s.voyage_id ? depOf.get(s.voyage_id) : null;
      const dep = depRaw ? Math.floor(-days(depRaw.replace(/^D\|/, ""))) : null; // días desde que zarpó
      const left = eta ? days(eta) : null;
      if (o.state !== "ok" && dep !== null) {
        const risk = "Si el contenedor llega sin los originales, la carga paga penalización.";
        if (arrived || (left !== null && left <= 10)) {
          items.push({ ...base, id: `orig-${c.id}`, priority: "alta", rule: "Originales",
            title: `URGENTE · ${name(c)}: ${o.state === "falta" ? "no hay guía de los originales" : "los originales aún no llegan"}`,
            detail: `${vesselOf(s)} · ${arrived ? "el contenedor ya llegó" : `llega en ${Math.max(0, Math.ceil(left!))} días`} · ${o.detail}. ${risk}`,
            action: o.state === "falta" ? "Llamar hoy al proveedor: exigir el envío por courier y registrar la guía." : "Dar seguimiento a la guía y avisar al agente aduanal." });
        } else if (o.state === "falta" && dep >= 14) {
          items.push({ ...base, id: `orig-guia-${c.id}`, priority: "alta", rule: "Originales",
            title: `${name(c)}: zarpó hace ${dep} días y todavía no hay guía de los originales`,
            detail: `${vesselOf(s)} · lo normal es que los envíen 1–2 semanas después de zarpar. ${risk}`,
            action: "Reclamar los originales al proveedor y registrar la guía en cuanto la den." });
        } else if (o.state === "falta" && dep >= 7) {
          items.push({ ...base, id: `orig-guia-${c.id}`, priority: "media", rule: "Originales",
            title: `Recordatorio · ${name(c)}: zarpó hace ${dep} días y aún no hay guía de los originales`,
            detail: `${vesselOf(s)} · si no hay guía es porque probablemente el proveedor no los ha enviado.`,
            action: "Preguntar al proveedor por los originales y registrar la guía." });
        }
      }
    }
    // 4c. La factura es la fuente madre: sin ella el vehículo no está confirmado
    if (invOf && !c.is_provisional && !invOf.get(c.id)) {
      items.push({ ...base, id: `factura-${c.id}`, priority: new Date(c.created_at) > new Date("2026-11-09T12:00:00Z") ? "media" : "baja", rule: "Sin factura",
        title: `${name(c)} no está confirmado: falta su factura`, detail: "Se creó desde otro documento. La factura es la que confirma que el chasis y los datos son correctos.",
        action: "Subir la factura de este vehículo en la Bandeja o por el bot." });
    }
    // 5. Chasis provisional
    if (c.is_provisional) {
      items.push({ ...base, id: `provisional-${c.id}`, priority: "baja", rule: "Chasis por asignar",
        title: `${name(c)} todavía no tiene chasis real`, detail: `Identificador temporal ${c.identifier}`,
        action: "Pedir el chasis al proveedor y reemplazar el identificador provisional." });
    }
    // 6. Sin foto principal (solo los que ya están en movimiento)
    if (!withPhoto.has(c.id) && ["con_reserva", "embarcado", "en_transito"].includes(c.stage)) {
      items.push({ ...base, id: `foto-${c.id}`, priority: "baja", rule: "Sin foto",
        title: `${name(c)} no tiene foto principal`, detail: "Ya está en camino y no se ve en el mapa con foto.",
        action: "Abrir el vehículo y subir sus fotos." });
    }
  }

  // 6b. Posibles duplicados: mismos 6 últimos caracteres y marca
  for (const [a, b] of findDuplicatePairs((veh.data ?? []) as any)) {
    const key = [a.id, b.id].sort().join("|");
    if (ignored.has(key)) continue;
    const mk = (x: any) => ({ id: x.id, identifier: x.identifier, label: vlabel(x) });
    items.push({ id: `dup-${key}`, priority: "alta", rule: "Posible duplicado", ref: a.identifier, vehicleId: a.id, dup: { a: mk(a), b: mk(b) },
      title: `¿Son el mismo vehículo? ${a.identifier} y ${b.identifier}`,
      detail: `${vlabel(a)} · terminan igual (${a.identifier.slice(-6)}). Una lectura borrosa suele producir esto.`,
      action: "Elige cuál es el chasis correcto para fusionarlos, o marca que son vehículos distintos." });
  }

  // 7. La ETA de un buque cambió 3 días o más
  for (const [voyageId, list] of etaList) {
    if (list.length < 2) continue;
    const ev: any = evOf.get(voyageId);
    if (ev && ["arrived", "discharged"].includes(ev.event_type)) continue;
    const shipment: any = (ships.data ?? []).find((s: any) => s.voyage_id === voyageId);
    const diff = Math.round((new Date(list[0].eta).getTime() - new Date(list[1].eta).getTime()) / DAY);
    if (Math.abs(diff) >= 3 && days(list[0].observed_at) > -10) {
      const n = (veh.data ?? []).filter((c: any) => shipment && c.shipment_id && (ships.data ?? []).some((s: any) => s.id === c.shipment_id && s.voyage_id === voyageId)).length;
      items.push({ id: `eta-${voyageId}`, priority: "media", rule: "Cambio de ETA", ref: vesselOf(shipment),
        title: `${vesselOf(shipment)} ${diff > 0 ? "se atrasó" : "se adelantó"} ${Math.abs(diff)} días`,
        detail: `Nueva ETA ${fmt(list[0].eta)} (antes ${fmt(list[1].eta)}) · ${n} vehículos`,
        action: diff > 0 ? "Avisar a quien espera estas unidades y revisar la fecha de despacho." : "Preparar documentos antes: llega más temprano." });
    }
  }

  // 8. El seguimiento no ha corrido
  const lastRun: string | null = (run.data?.value as any)?.at ?? null;
  if (!lastRun || days(lastRun) < -1.5) {
    items.push({ id: "seguimiento", priority: "media", rule: "Seguimiento detenido",
      title: lastRun ? `El seguimiento no se actualiza hace ${Math.round(-days(lastRun) * 24)} horas` : "El seguimiento nunca se ha ejecutado",
      detail: "Los datos de buques pueden estar desactualizados.", action: "Abrir la app de Claude en la laptop con el navegador integrado y la sesión iniciada." });
  }

  const order: Record<Priority, number> = { alta: 0, media: 1, baja: 2 };
  items.sort((a, b) => order[a.priority] - order[b.priority] || a.title.localeCompare(b.title));
  // Consumo del plan gratuito: al 80 % se empieza a evaluar el plan de pago
  try {
    const { data: sizes } = await sb.from("vehicle_media").select("size_bytes").limit(20000);
    const used = (sizes ?? []).reduce((n: number, r: any) => n + (r.size_bytes ?? 0), 0);
    const pct = used / SUPABASE_STORAGE_FREE_BYTES;
    if (pct >= PLAN_ALERT_PCT) {
      items.push({ id: "plan-storage", priority: "media", rule: "Plan gratuito", title: `El almacenamiento de fotos y videos está al ${Math.round(pct * 100)}% del plan gratuito de Supabase`,
        detail: `Fotos y videos: ${(used / 1024 ** 2).toFixed(0)} MB de ${(SUPABASE_STORAGE_FREE_BYTES / 1024 ** 2).toFixed(0)} MB (sin contar documentos).`,
        action: "Empezar a evaluar el plan de pago de Supabase y revisar también el uso de la base de datos y de Vercel en sus paneles." });
    }
  } catch {}
  return { items, role: prof.data?.role ?? "consulta", lastRun };
}
