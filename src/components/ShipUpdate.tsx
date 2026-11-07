"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import type { ShipView } from "@/lib/map-data";
import { TRACK_EVENTS } from "@/lib/tracking";

const EVENTS = TRACK_EVENTS;

export default function ShipUpdate({ ship }: { ship: ShipView }) {
  const router = useRouter();
  const options = EVENTS.filter((e) => ship.mode === "container" || e.roro);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState(options[0].code);
  const [pct, setPct] = useState(0);
  const [eta, setEta] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const free = code === "in_transit" || code === "departed";

  function pick(c: string) {
    setCode(c);
    setPct(Math.round((EVENTS.find((e) => e.code === c)!.progress) * 100));
  }

  async function save() {
    setBusy(true); setMsg("");
    const sb = createClient();
    const ev = EVENTS.find((e) => e.code === code)!;
    const a = await sb.from("tracking_events").insert({
      voyage_id: ship.id, event_type: code, source: "manual", route_progress: pct / 100,
    });
    if (a.error) { setBusy(false); return setMsg(a.error.message); }
    if (eta) {
      const b = await sb.from("eta_observations").insert({ voyage_id: ship.id, eta, source: "carrier_site" });
      if (b.error) { setBusy(false); return setMsg(b.error.message); }
    }
    const c = await sb.from("vehicles").update({ stage: ev.stage }).in("shipment_id", ship.shipmentIds);
    setBusy(false);
    if (c.error) return setMsg(c.error.message);
    setMsg("Actualizado.");
    router.refresh();
  }

  if (!open) {
    return <button onClick={() => { pick(options[0].code); setOpen(true); }} className="mx-4 mb-4 border border-white/40 px-3 py-1.5 text-xs hover:bg-white hover:text-black">Actualizar estado del buque</button>;
  }
  return (
    <div className="mx-4 mb-4 border border-white/20 p-3 text-sm space-y-3">
      <div className="text-[10px] tracking-[0.3em] text-white/40">ACTUALIZAR A MANO</div>
      <label className="block">
        <span className="text-xs text-white/50">Último evento que ves en la naviera</span>
        <select value={code} onChange={(e) => pick(e.target.value)} className="mt-1 w-full bg-black border border-white/30 px-2 py-1.5">
          {options.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="text-xs text-white/50">Posición en la ruta: {pct}%{free ? "" : " (automática para este evento)"}</span>
        <input type="range" min={0} max={100} value={pct} disabled={!free} onChange={(e) => setPct(+e.target.value)} className="w-full" />
      </label>
      <label className="block">
        <span className="text-xs text-white/50">ETA a destino (opcional)</span>
        <input type="date" value={eta} onChange={(e) => setEta(e.target.value)} className="mt-1 w-full bg-black border border-white/30 px-2 py-1.5 [color-scheme:dark]" />
      </label>
      <div className="flex gap-2">
        <button disabled={busy} onClick={save} className="border border-white px-3 py-1.5 hover:bg-white hover:text-black disabled:opacity-50">{busy ? "Guardando…" : "Guardar"}</button>
        <button onClick={() => setOpen(false)} className="text-white/50 px-2">Cerrar</button>
      </div>
      <p className="text-[11px] text-white/35">Los vehículos de este buque cambian de etapa según el evento.</p>
      {msg && <p className="text-xs text-white/70">{msg}</p>}
    </div>
  );
}
