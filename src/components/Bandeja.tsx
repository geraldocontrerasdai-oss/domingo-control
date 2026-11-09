"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/browser";
import { normalizeVin, vinWarnings } from "@/lib/vin";
import { loadIndex, matchVin, label as vlabel, type VRow } from "@/lib/vin-match";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Veh = { vin: string; year?: number; make?: string; model?: string; color?: string; origin_place?: string; supplier?: string; container_no?: string; warnings?: string[]; sameAs?: { id: string; identifier: string; shipment_id: string | null; orig: string } };
type Result = { carrier_info?: { name: string | null; known: boolean }; doc_type: string; origin?: string; vehicles: Veh[]; shipment?: any; courier?: any; notes?: string };
type Item = { id: string; file: File; status: "analyzing" | "ready" | "error" | "saved"; error?: string; result?: Result; note?: string };

const TYPES: Record<string, string> = {
  bl: "BL", invoice: "Factura (no se guarda)", gate_pass: "Gate Pass", crowley_tag: "Etiqueta Crowley", title: "Título",
  courier_receipt: "Guía de courier", vehicle_photo: "Foto del vehículo", other: "Otro (no se guarda)",
};
const FOLDER: Record<string, string> = { bl: "bl", gate_pass: "gate-pass", crowley_tag: "etiqueta-crowley", title: "titulo", courier_receipt: "courier" };
const STORED = Object.keys(FOLDER);
const SINGLE = ["crowley_tag", "gate_pass", "title"];
const skelDiff = (a: string, b: string) => a.replace(/[OQ]/g, "0").replace(/I/g, "1") !== b.replace(/[OQ]/g, "0").replace(/I/g, "1");

async function sha256(f: File) {
  const h = await crypto.subtle.digest("SHA-256", await f.arrayBuffer());
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function Bandeja() {
  const [items, setItems] = useState<Item[]>([]);
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [index, setIndex] = useState<VRow[]>([]);
  useEffect(() => { loadIndex(createClient()).then(setIndex); }, []);

  const patch = (id: string, f: (i: Item) => Item) => setItems((l) => l.map((i) => (i.id === id ? f(i) : i)));
  const edit = (id: string, f: (r: Result) => void) => patch(id, (i) => { const r = structuredClone(i.result!); f(r); return { ...i, result: r }; });

  async function analyze(item: Item) {
    const fd = new FormData();
    fd.append("file", item.file);
    try {
      const r = await fetch("/api/intake/analyze", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({ error: `Error ${r.status}` }));
      if (!r.ok) throw new Error(j.error ?? `Error ${r.status}`);
      patch(item.id, (i) => ({ ...i, status: "ready", result: j.result }));
    } catch (e) {
      patch(item.id, (i) => ({ ...i, status: "error", error: e instanceof Error ? e.message : "Error" }));
    }
  }

  async function add(files: FileList | File[]) {
    const list: Item[] = Array.from(files).map((file) => ({ id: crypto.randomUUID(), file, status: "analyzing" }));
    setItems((l) => [...l, ...list]);
    // De dos en dos, para no saturar la IA
    for (let i = 0; i < list.length; i += 2) await Promise.all(list.slice(i, i + 2).map(analyze));
  }

  async function confirm() {
    setSaving(true); setMsg("");
    const sb = createClient();
    const ready = items.filter((i) => i.status === "ready");
    try {
      const payload: any[] = [];
      const renames: { id: string; vin: string }[] = [];
      const invVins: string[] = [];
      let sinFactura = 0;
      const photos: { item: Item; vin: string }[] = [];
      for (const it of ready) {
        const r = it.result!;
        const isInv = r.doc_type === "invoice";
        let shipment = r.shipment;
        const vehicles = r.vehicles.filter((v) => v.vin).map((v) => {
          const vin = normalizeVin(v.vin);
          const m = matchVin(vin, index, { isInvoice: isInv, make: v.make });
          if (m.exact) { if (m.exact.shipment_id && SINGLE.includes(r.doc_type)) shipment = {}; return { ...v, vin: m.exact.identifier }; }
          if (v.sameAs) {
            if (v.sameAs.shipment_id && SINGLE.includes(r.doc_type)) shipment = {};
            if (isInv && skelDiff(vin, v.sameAs.identifier)) renames.push({ id: v.sameAs.id, vin });
            return { ...v, vin: v.sameAs.identifier };
          }
          if (!isInv) sinFactura++;
          return { ...v, vin };
        });
        invVins.push(...(isInv ? vehicles.map((v) => renames.find((x) => index.find((i) => i.id === x.id)?.identifier === v.vin)?.vin ?? v.vin) : []));
        let storage_path: string | undefined, hash: string | undefined;
        if (r.doc_type === "vehicle_photo") { if (vehicles[0]) photos.push({ item: it, vin: vehicles[0].vin }); continue; }
        if (STORED.includes(r.doc_type)) {
          hash = await sha256(it.file);
          const owner = r.doc_type === "bl" ? `embarques/${r.shipment?.bl_no || r.shipment?.booking_no || "sin-numero"}` : `vehiculos/${vehicles[0]?.vin ?? "sin-vin"}`;
          storage_path = `${owner}/${FOLDER[r.doc_type]}/${hash.slice(0, 8)}-${it.file.name.replace(/[^\w.\-]+/g, "_")}`;
          const up = await sb.storage.from("documents").upload(storage_path, it.file, { contentType: it.file.type, upsert: false });
          if (up.error && !/exists/i.test(up.error.message)) throw new Error(`${it.file.name}: ${up.error.message}`);
        }
        payload.push({ doc_type: r.doc_type, origin: r.origin, shipment, courier: r.courier, vehicles, storage_path, sha256: hash });
      }
      const { data, error } = await sb.rpc("intake_commit", { p_items: payload });
      if (error) throw new Error(/sha256/.test(error.message) ? "Uno de los documentos ya estaba cargado." : error.message);

      // La factura manda: corrige el chasis registrado si estaba mal leído y confirma el vehículo
      for (const x of renames) await sb.from("vehicles").update({ identifier: x.vin, id_kind: x.vin.length === 17 ? "vin" : "chassis" }).eq("id", x.id);
      if (invVins.length) await sb.from("vehicles").update({ invoice_confirmed_at: new Date().toISOString() }).in("identifier", invVins).is("invoice_confirmed_at", null);
      loadIndex(sb).then(setIndex);

      let fotos = 0;
      for (const p of photos) {
        const { data: v } = await sb.from("vehicles").select("id").eq("identifier", p.vin).maybeSingle();
        if (!v) { patch(p.item.id, (i) => ({ ...i, note: "No encontré ese chasis: crea el vehículo primero." })); continue; }
        const path = `${v.id}/${crypto.randomUUID()}.${p.item.file.type === "image/png" ? "png" : "jpg"}`;
        const up = await sb.storage.from("vehicle-media").upload(path, p.item.file, { contentType: p.item.file.type });
        if (!up.error) { await sb.from("vehicle_media").insert({ vehicle_id: v.id, kind: "photo", storage_path: path, content_type: p.item.file.type, size_bytes: p.item.file.size }); fotos++; }
      }
      setItems((l) => l.map((i) => (i.status === "ready" ? { ...i, status: "saved" } : i)));
      setMsg(`Listo: ${data.vehicles_new} vehículo(s) nuevo(s), ${data.vehicles_updated} actualizado(s), ${data.shipments_new} embarque(s), ${data.documents} documento(s) guardado(s)${fotos ? `, ${fotos} foto(s)` : ""}.${sinFactura ? ` ⚠ ${sinFactura} vehículo(s) quedaron sin confirmar: falta subir su factura.` : ""}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "No se pudo guardar");
    }
    setSaving(false);
  }

  const readyCount = items.filter((i) => i.status === "ready").length;
  const field = "bg-black border border-white/25 px-2 py-1 text-sm w-full";

  return (
    <div className="max-w-5xl mx-auto p-6">
      <h1 className="text-xs tracking-[0.3em] text-white/60">BANDEJA DE DOCUMENTOS</h1>
      <p className="text-sm text-white/50 mt-2">Sube todo aquí: BL, facturas, Gate Pass, etiquetas de Crowley, títulos, guías de courier. La plataforma reconoce cada documento, lee los datos y los guarda en la carpeta del vehículo. Tú revisas y confirmas.</p>
      <p className="text-xs text-amber-200/80 mt-1">Las facturas se leen y se descartan: el archivo no se guarda y los montos se ignoran.</p>

      <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); add(e.dataTransfer.files); }}
        onClick={() => input.current?.click()} className="mt-5 border border-dashed border-white/30 hover:border-white p-10 text-center cursor-pointer text-white/60">
        Arrastra los archivos aquí o haz clic para elegirlos
        <div className="text-xs text-white/35 mt-1">PDF, JPG, PNG o WEBP · hasta 4 MB cada uno</div>
        <input ref={input} type="file" multiple accept="application/pdf,image/*" className="hidden" onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ""; }} />
      </div>

      <div className="mt-6 space-y-4">
        {items.map((it) => (
          <div key={it.id} className="border border-white/15 p-4">
            <div className="flex justify-between gap-3 text-sm">
              <span className="truncate">{it.file.name}</span>
              <span className="text-white/50 shrink-0">{it.status === "analyzing" ? "Leyendo…" : it.status === "saved" ? "Guardado ✓" : it.status === "error" ? "Error" : "Listo para revisar"}</span>
            </div>
            {it.status === "error" && (
              <div className="mt-2 text-sm">
                <p className="text-red-300">{it.error}</p>
                <div className="mt-2 flex gap-3">
                  <button onClick={() => { patch(it.id, (i) => ({ ...i, status: "analyzing", error: undefined })); analyze(it); }} className="border border-white/30 px-3 py-1 text-xs hover:bg-white hover:text-black">Reintentar</button>
                  <button onClick={() => patch(it.id, (i) => ({ ...i, status: "ready", result: { doc_type: "bl", origin: "other", vehicles: [{ vin: "" }], shipment: {} } }))} className="border border-white/30 px-3 py-1 text-xs hover:bg-white hover:text-black">Llenar a mano</button>
                </div>
              </div>
            )}
            {it.note && <p className="text-sm text-amber-200 mt-2">{it.note}</p>}

            {it.status === "ready" && it.result && (() => {
              const r = it.result, s = r.shipment ?? {};
              const setS = (k: string, v: string) => edit(it.id, (x) => { x.shipment = { ...(x.shipment ?? {}), [k]: v }; });
              return (
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-xs text-white/50">Tipo de documento
                      <select className={field} value={r.doc_type} onChange={(e) => edit(it.id, (x) => { x.doc_type = e.target.value; })}>
                        {Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select></label>
                    <label className="text-xs text-white/50">Origen
                      <select className={field} value={r.origin ?? "other"} onChange={(e) => edit(it.id, (x) => { x.origin = e.target.value; })}>
                        <option value="manheim">Manheim / EE. UU.</option><option value="japan">Japón</option><option value="other">Otro (China, etc.)</option>
                      </select></label>
                  </div>

                  {r.doc_type === "bl" && (
                    <p className={`text-xs ${r.carrier_info?.known ? "text-white/50" : "text-amber-200"}`}>
                      {r.carrier_info?.known ? `Naviera reconocida: ${r.carrier_info.name}.` : `Naviera ${r.carrier_info?.name ? `“${r.carrier_info.name}” ` : ""}sin enlace de seguimiento propio: el BL se guarda igual y el estado se actualiza a mano.`}
                    </p>
                  )}
                  {(r.doc_type === "bl" || s.booking_no || s.bl_no) && (
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                      {([["booking_no", "Booking"], ["bl_no", "BL"], ["carrier", "Naviera"], ["vessel", "Buque"], ["voyage", "Viaje"], ["port_loading", "Puerto de carga"], ["port_discharge", "Puerto de descarga"], ["consignee", "Consignatario"]] as const).map(([k, label]) => (
                        <label key={k} className="text-xs text-white/50">{label}<input className={field} value={s[k] ?? ""} onChange={(e) => setS(k, e.target.value)} /></label>
                      ))}
                      <label className="text-xs text-white/50">Contenedor(es)
                        <input className={field} value={(s.containers ?? []).join(", ")} onChange={(e) => edit(it.id, (x) => { x.shipment = { ...(x.shipment ?? {}), containers: e.target.value.split(/[ ,]+/).filter(Boolean) }; })} /></label>
                      <label className="text-xs text-white/50">Estado del BL
                        <select className={field} value={s.bl_status ?? "draft"} onChange={(e) => setS("bl_status", e.target.value)}><option value="draft">Borrador</option><option value="final">Definitivo</option></select></label>
                      <label className="text-xs text-white/50">Tipo de carga
                        <select className={field} value={s.mode ?? "container"} onChange={(e) => setS("mode", e.target.value)}><option value="container">Contenedor</option><option value="roro">RORO</option></select></label>
                    </div>
                  )}

                  {r.courier?.tracking_no && (
                    <div className="text-sm text-white/70">Guía {String(r.courier.carrier).toUpperCase()}: <span className="font-mono">{r.courier.tracking_no}</span></div>
                  )}

                  <div>
                    <div className="text-[10px] tracking-[0.3em] text-white/40 mb-2">VEHÍCULOS · {r.vehicles.length}</div>
                    {r.vehicles.length === 0 && <p className="text-sm text-amber-200">No encontré ningún chasis en este documento.</p>}
                    {r.vehicles.map((v, idx) => (
                      <div key={idx} className="mb-2">
                        <div className="grid grid-cols-6 gap-2">
                          <input className={`${field} col-span-2 font-mono`} value={v.vin} onChange={(e) => edit(it.id, (x) => { const n = normalizeVin(e.target.value); x.vehicles[idx].vin = n; x.vehicles[idx].sameAs = undefined; x.vehicles[idx].warnings = vinWarnings(n); })} />
                          {(["year", "make", "model", "color"] as const).map((k) => (
                            <input key={k} className={field} placeholder={k === "year" ? "Año" : k === "make" ? "Marca" : k === "model" ? "Modelo" : "Color"} value={(v as any)[k] ?? ""}
                              onChange={(e) => edit(it.id, (x) => { (x.vehicles[idx] as any)[k] = k === "year" ? Number(e.target.value) || undefined : e.target.value; })} />
                          ))}
                        </div>
                        {(v.warnings ?? []).map((w) => <div key={w} className="text-xs text-amber-200 mt-1">⚠ {w}</div>)}
                        {(() => {
                          if (!v.vin) return null;
                          const m = matchVin(v.vin, index, { isInvoice: r.doc_type === "invoice", make: v.make });
                          if (m.exact) return <div className="text-xs text-emerald-300/90 mt-1">✓ Ya está registrado: {vlabel(m.exact)}{m.exact.invoice_confirmed_at ? " (confirmado por factura)" : ""}. Se completará su expediente.</div>;
                          if (v.sameAs) return <div className="text-xs text-emerald-300/90 mt-1">↪ Se usará el vehículo ya registrado {v.sameAs.identifier}{r.doc_type === "invoice" && skelDiff(v.vin, v.sameAs.identifier) ? ", corrigiendo su chasis con el de la factura" : ""}. <button className="underline text-white/60" onClick={() => edit(it.id, (x) => { x.vehicles[idx].sameAs = undefined; })}>deshacer</button></div>;
                          return m.similar.map((c) => (
                            <div key={c.row.id} className="text-xs text-amber-200 mt-1">⚠ Se parece a {vlabel(c.row)} <span className="font-mono">{c.row.identifier}</span> ({c.why}). ¿Es el mismo?{" "}
                              <button className="underline text-white" onClick={() => edit(it.id, (x) => { x.vehicles[idx].sameAs = { id: c.row.id, identifier: c.row.identifier, shipment_id: c.row.shipment_id, orig: v.vin }; })}>Sí, es el mismo</button></div>
                          ));
                        })()}
                        {!["invoice", "vehicle_photo"].includes(r.doc_type) && v.vin && !matchVin(v.vin, index, { isInvoice: false, make: v.make }).exact && !v.sameAs && <div className="text-xs text-white/40 mt-1">Vehículo nuevo sin factura: quedará "sin confirmar" hasta que subas su factura.</div>}
                      </div>
                    ))}
                  </div>
                  {r.notes && <p className="text-xs text-white/50">Nota de la lectura: {r.notes}</p>}
                </div>
              );
            })()}
          </div>
        ))}
      </div>

      {readyCount > 0 && (
        <div className="sticky bottom-0 bg-black/95 border-t border-white/15 mt-6 py-4 flex items-center gap-4">
          <button disabled={saving} onClick={confirm} className="border border-white px-5 py-2 hover:bg-white hover:text-black disabled:opacity-50">
            {saving ? "Guardando…" : `Confirmar ${readyCount} documento(s)`}
          </button>
          <span className="text-xs text-white/40">Revisa los datos: nada se crea hasta que confirmes.</span>
        </div>
      )}
      {msg && <p className="mt-4 text-sm text-white/80">{msg} {msg.startsWith("Listo") && <Link href="/mapa" className="underline">Ver el mapa</Link>}</p>}
    </div>
  );
}
