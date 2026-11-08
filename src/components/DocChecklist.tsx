"use client";
import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { buildChecklist, type CourierInfo, type Item, type OriginKind } from "@/lib/checklist";

const DOT = { falta: "#fca5a5", transito: "#fde68a", ok: "#86efac" } as const;
const TXT = { falta: "FALTA", transito: "EN CAMINO", ok: "LISTO" } as const;

export default function DocChecklist({ vehicleId, shipmentId, blStatus, canEdit }: { vehicleId: string; shipmentId: string | null; blStatus: string; canEdit: boolean }) {
  const [items, setItems] = useState<Item[]>([]);
  const [couriers, setCouriers] = useState<CourierInfo[]>([]);
  const [kind, setKind] = useState<OriginKind>("other");
  const [open, setOpen] = useState(false);
  const [carrier, setCarrier] = useState("fedex");
  const [no, setNo] = useState("");
  const [all, setAll] = useState(true);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const sb = createClient();
    const ors = [`vehicle_id.eq.${vehicleId}`, ...(shipmentId ? [`shipment_id.eq.${shipmentId}`] : [])].join(",");
    const [v, d, cv] = await Promise.all([
      sb.from("vehicles").select("origin").eq("id", vehicleId).single(),
      sb.from("documents").select("doc_type").or(ors).eq("is_current", true).is("archived_at", null),
      sb.from("courier_vehicles").select("courier:courier_shipments(id, kind, carrier, tracking_no, received_confirmed_at)").eq("vehicle_id", vehicleId),
    ]);
    const origin = (v.data?.origin ?? "other") as OriginKind;
    const cs: CourierInfo[] = (cv.data ?? []).map((r: any) => (Array.isArray(r.courier) ? r.courier[0] : r.courier)).filter(Boolean)
      .map((c: any) => ({ id: c.id, kind: c.kind, carrier: c.carrier, tracking_no: c.tracking_no, received: !!c.received_confirmed_at }));
    setKind(origin); setCouriers(cs);
    setItems(buildChecklist({ origin, blStatus, docTypes: new Set((d.data ?? []).map((x: any) => x.doc_type)), couriers: cs }));
  }, [vehicleId, shipmentId, blStatus]);
  useEffect(() => { load(); }, [load]);

  const ckind = kind === "manheim" ? "titulo" : "original_bl";
  const pending = couriers.find((c) => c.kind === ckind && !c.received);

  async function addGuide() {
    const n = no.trim();
    if (!n) return;
    const sb = createClient();
    let id: string | undefined;
    const ex = await sb.from("courier_shipments").select("id").eq("carrier", carrier).eq("tracking_no", n).maybeSingle();
    if (ex.data) id = ex.data.id;
    else {
      const ins = await sb.from("courier_shipments").insert({ carrier, tracking_no: n, kind: ckind }).select("id").single();
      if (ins.error) { setMsg(ins.error.message); return; }
      id = ins.data.id;
    }
    let ids = [vehicleId];
    if (all && shipmentId && ckind === "original_bl") {
      const sib = await sb.from("vehicles").select("id").eq("shipment_id", shipmentId).is("archived_at", null);
      ids = (sib.data ?? []).map((x: any) => x.id);
    }
    const link = await sb.from("courier_vehicles").upsert(ids.map((vehicle_id) => ({ courier_id: id, vehicle_id })), { onConflict: "courier_id,vehicle_id", ignoreDuplicates: true });
    if (link.error) { setMsg(link.error.message); return; }
    setNo(""); setOpen(false); setMsg(`Guía guardada para ${ids.length} vehículo(s).`); load();
  }

  async function markReceived(c: CourierInfo) {
    if (!window.confirm(`¿Confirmas que ya tienes en la mano el ${ckind === "titulo" ? "título" : "juego de originales"}? Esto cierra la tarea.`)) return;
    const sb = createClient();
    const { data: { user } } = await sb.auth.getUser();
    const { error } = await sb.from("courier_shipments").update({ received_confirmed_by: user!.id, received_confirmed_at: new Date().toISOString() }).eq("id", c.id!);
    setMsg(error ? error.message : "Recibido confirmado."); load();
  }

  return (
    <div>
      <dt className="text-[10px] tracking-[0.2em] text-white/40">CHECKLIST PARA DESPACHO</dt>
      <dd className="mt-1 space-y-1.5">
        {items.map((i) => (
          <div key={i.key} className="border border-white/15 px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs">{i.label}</span>
              <span className="text-[9px] tracking-widest shrink-0" style={{ color: DOT[i.state] }}>● {TXT[i.state]}</span>
            </div>
            <div className="text-[11px] text-white/50">{i.detail}</div>
            {i.state !== "ok" && i.blocking && <div className="text-[11px] mt-0.5" style={{ color: DOT[i.state] }}>{i.blocking}</div>}
          </div>
        ))}
        {canEdit && (kind === "manheim" || shipmentId) && items.some((i) => i.key === "title" || i.key === "originals") && (
          <div className="pt-1 text-xs space-y-1.5">
            {pending && <button onClick={() => markReceived(pending)} className="w-full border border-white/40 px-2 py-1.5 hover:bg-white hover:text-black">Ya recibí {ckind === "titulo" ? "el título" : "los originales"}</button>}
            {!pending && !couriers.some((c) => c.kind === ckind && c.received) && !open && <button onClick={() => setOpen(true)} className="w-full border border-white/40 px-2 py-1.5 hover:bg-white hover:text-black">Agregar guía de courier</button>}
            {open && (
              <div className="border border-white/20 p-2 space-y-2">
                <select value={carrier} onChange={(e) => setCarrier(e.target.value)} className="w-full bg-black border border-white/30 px-2 py-1">
                  <option value="fedex">FedEx</option><option value="dhl">DHL</option><option value="other">Otro</option>
                </select>
                <input value={no} onChange={(e) => setNo(e.target.value)} placeholder="Número de guía" className="w-full bg-black border border-white/30 px-2 py-1 font-mono" />
                {ckind === "original_bl" && shipmentId && <label className="flex gap-2 items-center text-white/60"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />Aplica a todos los vehículos de este embarque</label>}
                <div className="flex gap-2"><button onClick={addGuide} className="border border-white px-2 py-1 hover:bg-white hover:text-black">Guardar</button><button onClick={() => setOpen(false)} className="border border-white/20 px-2 py-1 text-white/60">Cancelar</button></div>
              </div>
            )}
            {msg && <p className="text-white/60">{msg}</p>}
          </div>
        )}
      </dd>
    </div>
  );
}
