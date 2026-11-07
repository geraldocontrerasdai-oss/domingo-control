"use client";
import { useState } from "react";
import type { PrevShip, VehicleCard } from "@/lib/map-data";
import { STAGES } from "@/lib/format";
import VehicleDrawer from "./VehicleDrawer";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("es-DO", { day: "numeric", month: "short", year: "numeric", timeZone: "America/Santo_Domingo" }) : "—");

// Viajes descargados hace más de 3 semanas. Siguen consultables, con sus fotos y documentos.
export default function PreviousList({ data, role }: { data: PrevShip[]; role: string }) {
  const [car, setCar] = useState<VehicleCard | null>(null);
  const canEdit = role === "admin" || role === "operaciones";
  return (
    <div className="max-w-6xl mx-auto p-6 text-white">
      <p className="text-xs text-white/40 mb-4">Viajes descargados hace más de 3 semanas. Salen del mapa pero siguen aquí con todo su expediente.</p>
      {data.length === 0 && <div className="border border-white/10 p-8 text-center text-white/40 text-sm">Todavía no hay viajes anteriores.</div>}
      {data.map((s) => (
        <section key={s.id} className="border border-white/10 mb-4">
          <header className="px-4 py-3 border-b border-white/10 flex flex-wrap gap-x-6 gap-y-1 items-baseline">
            <span className="text-sm">{s.name}</span>
            <span className="text-xs text-white/50">{s.carrier} · {s.route}</span>
            <span className="text-xs text-white/50">{s.event} el {fmt(s.doneAt)}</span>
            {s.trackNumber && <span className="font-mono text-xs text-white/35">{s.trackNumber}</span>}
          </header>
          {s.vehicles.map((c) => (
            <button key={c.id} onClick={() => setCar(c)} className="w-full text-left flex items-center gap-4 px-4 py-2 border-b border-white/5 last:border-0 hover:bg-white/5">
              <div className="w-16 h-12 shrink-0 bg-white/10 overflow-hidden grid place-items-center text-[9px] text-white/35">
                {c.photo /* eslint-disable-next-line @next/next/no-img-element */ ? <img src={c.photo} alt="" className="w-full h-full object-cover" /> : "sin foto"}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm truncate">{c.title}{c.color ? <span className="text-white/40"> · {c.color}</span> : null}</div>
                <div className="font-mono text-xs text-white/50">{c.identifier}</div>
              </div>
              <div className="text-xs text-white/60">{STAGES[c.stage] ?? c.stage}</div>
            </button>
          ))}
        </section>
      ))}
      {car && <VehicleDrawer car={car} canEdit={canEdit} onClose={() => setCar(null)} />}
    </div>
  );
}
