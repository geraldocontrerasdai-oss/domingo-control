"use client";
import { useMemo, useState } from "react";
import { GRAT, LAND } from "@/lib/land";
import type { MapData, ShipView, VehicleCard } from "@/lib/map-data";
import { ago, shortDate } from "@/lib/format";
import VehicleDrawer from "./VehicleDrawer";
import ShipUpdate from "./ShipUpdate";
import AppNav from "./AppNav";

const W = 1000, H = 520;
const CARIBE = { x: 470, y: 160, w: 300, h: 156 };

function Thumb({ car, size = 44 }: { car: VehicleCard; size?: number }) {
  return (
    <div style={{ width: size, height: size * 0.75 }} className="shrink-0 bg-white/10 overflow-hidden grid place-items-center text-[9px] text-white/40">
      {car.photo /* eslint-disable-next-line @next/next/no-img-element */ ? <img src={car.photo} alt="" className="w-full h-full object-cover" /> : "sin foto"}
    </div>
  );
}

export default function MapView({ data }: { data: MapData }) {
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);
  const [car, setCar] = useState<VehicleCard | null>(null);
  const canEdit = data.role === "admin" || data.role === "operaciones";

  const view = zoom ? CARIBE : { x: 0, y: 0, w: W, h: H };
  const k = W / view.w; // factor de acercamiento: los marcadores se mantienen del mismo tamaño
  const ship = useMemo(() => data.ships.find((s) => s.id === sel) ?? null, [data.ships, sel]);
  const hov = useMemo(() => data.ships.find((s) => s.id === hover) ?? null, [data.ships, hover]);
  const total = data.ships.reduce((n, s) => n + s.vehicles.length, 0);

  const px = (s: ShipView) => ({ x: s.pos.x * 10, y: s.pos.y * 5.2 });

  return (
    <div className="h-screen flex flex-col bg-black text-white overflow-hidden">
      <AppNav role={data.role} info={`${data.ships.length} buques · ${total} vehículos en ruta${data.unassigned ? ` · ${data.unassigned} sin embarque` : ""} · seguimiento ${data.lastRun ? ago(data.lastRun) : "sin ejecutar"}`} />

      <div className="relative flex-1 min-h-0">
        <svg viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} preserveAspectRatio="xMidYMid meet"
          className="absolute inset-0 w-full h-full transition-all" onClick={() => setSel(null)}>
          <path d={GRAT} fill="none" stroke="#fff" strokeOpacity="0.06" strokeWidth="0.5" vectorEffect="non-scaling-stroke" />
          <path d={LAND} fill="#15171a" stroke="#fff" strokeOpacity="0.28" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />

          {data.ships.map((s) => {
            const on = sel === s.id || hover === s.id;
            const dim = (sel && sel !== s.id) ? 0.25 : 1;
            return (
              <g key={s.id} opacity={dim}>
                <path d={s.done} fill="none" stroke={s.color} strokeWidth={on ? 3 : 2} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                <path d={s.todo} fill="none" stroke={s.color} strokeOpacity="0.55" strokeWidth={on ? 2.2 : 1.4} strokeDasharray="5 5" vectorEffect="non-scaling-stroke" />
              </g>
            );
          })}

          {data.ports.map((p) => (
            <g key={p.name} transform={`translate(${p.x * 10} ${p.y * 5.2})`} opacity={zoom && p.name === "Yokohama" ? 0 : 1}>
              <circle r={2.6 / k} fill="#000" stroke="#fff" strokeWidth={1 / k} />
              <text x={5 / k} y={-5 / k} fontSize={9 / k} fill="#fff" fillOpacity="0.6" letterSpacing="0.05em">{p.name}</text>
            </g>
          ))}

          {data.ships.map((s) => {
            const { x, y } = px(s);
            const r = 10 / k;
            const dim = (sel && sel !== s.id) ? 0.3 : 1;
            return (
              <g key={s.id} transform={`translate(${x} ${y})`} opacity={dim} className="cursor-pointer"
                onMouseEnter={() => setHover(s.id)} onMouseLeave={() => setHover(null)}
                onClick={(e) => { e.stopPropagation(); setSel(s.id); }}>
                <circle r={r * 2} fill="transparent" />
                {s.mode === "roro"
                  ? <rect x={-r} y={-r} width={r * 2} height={r * 2} fill="#000" stroke={s.color} strokeWidth={2 / k} />
                  : <circle r={r} fill="#000" stroke={s.color} strokeWidth={2 / k} />}
                <text textAnchor="middle" dy={r * 0.38} fontSize={r * 1.1} fontWeight="600" fill={s.color}>{s.num}</text>
              </g>
            );
          })}
        </svg>

        {data.ships.length === 0 && (
          <div className="absolute inset-0 grid place-items-center text-white/40 text-sm pointer-events-none">
            Todavía no hay embarques cargados.
          </div>
        )}

        {/* Guía de buques */}
        <div className="absolute left-4 top-4 w-64 border border-white/15 bg-black/80 backdrop-blur">
          <div className="px-3 py-2 text-[10px] tracking-[0.3em] text-white/50 border-b border-white/10">GUÍA DE BUQUES</div>
          {data.ships.map((s) => (
            <button key={s.id} onClick={() => setSel(s.id)} onMouseEnter={() => setHover(s.id)} onMouseLeave={() => setHover(null)}
              className={`w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-white/10 ${sel === s.id ? "bg-white/10" : ""}`}>
              <span className="w-6 h-6 grid place-items-center text-xs shrink-0" style={{ border: `1.5px solid ${s.color}`, color: s.color, borderRadius: s.mode === "roro" ? 0 : 999 }}>{s.num}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm truncate">{s.name}</span>
                <span className="block text-[11px] text-white/45 truncate">{s.vehicles.length} veh. · ETA {shortDate(s.eta)}</span>
              </span>
            </button>
          ))}
          <div className="px-3 py-2 text-[10px] text-white/35 border-t border-white/10">Sin AIS: posición según el último evento de la naviera.</div>
        </div>

        <button onClick={() => setZoom((z) => !z)} className="absolute left-4 bottom-4 border border-white/30 bg-black/80 px-3 py-1.5 text-xs hover:bg-white hover:text-black">
          {zoom ? "Ver mundo" : "Acercar al Caribe"}
        </button>

        {/* Ventana al pasar el cursor: carga del buque */}
        {hov && !ship && (
          <div className="absolute z-20 w-72 border border-white/25 bg-black/95 pointer-events-none"
            style={{ left: `${hov.pos.x > 60 ? hov.pos.x - 2 : hov.pos.x + 2}%`, top: `${Math.min(hov.pos.y, 60)}%`, transform: hov.pos.x > 60 ? "translateX(-100%)" : undefined }}>
            <div className="px-3 py-2 border-b border-white/10">
              <div className="text-sm">{hov.name} <span className="text-white/40">{hov.voyage}</span></div>
              <div className="text-[11px] text-white/50">{hov.event} · {ago(hov.eventAt)}</div>
            </div>
            {hov.vehicles.map((c) => (
              <div key={c.id} className="flex gap-2 px-3 py-2 border-b border-white/5 last:border-0">
                <Thumb car={c} />
                <div className="min-w-0 text-[11px]">
                  <div className="text-[12px] truncate">{c.title}</div>
                  <div className="font-mono text-white/50 truncate">{c.identifier}</div>
                  <div className="text-white/40 truncate">BL {c.bl ?? "pendiente"}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Panel del buque seleccionado */}
        {ship && (
          <aside className="absolute right-0 top-0 bottom-0 w-[380px] max-w-full border-l border-white/15 bg-black/95 overflow-y-auto z-30">
            <div className="p-4 border-b border-white/10 flex justify-between items-start">
              <div>
                <div className="text-[10px] tracking-[0.3em]" style={{ color: ship.color }}>{ship.mode === "roro" ? "RORO" : "CONTENEDOR"} · {ship.num}</div>
                <h2 className="text-lg mt-1">{ship.name}</h2>
                <div className="text-xs text-white/50">{ship.carrier} · viaje {ship.voyage}</div>
              </div>
              <button onClick={() => setSel(null)} className="text-white/50 hover:text-white text-sm">✕</button>
            </div>
            <div className="p-4 text-sm space-y-2 border-b border-white/10">
              <div><span className="text-white/40">Ruta </span>{ship.route}</div>
              <div><span className="text-white/40">Último evento </span>{ship.event}</div>
              <div className="text-xs text-white/40">Dato de la naviera {ago(ship.eventAt)}</div>
              <div><span className="text-white/40">ETA </span>{shortDate(ship.eta)}{ship.etaSource ? <span className="text-white/35 text-xs"> · {ship.etaSource.replace("_", " ")}</span> : null}</div>
            </div>
            {ship.trackUrl && (
              <div className="px-4 pb-4 -mt-1 text-xs">
                <a href={ship.trackUrl} target="_blank" rel="noreferrer" className="inline-block border border-white/30 px-3 py-1.5 hover:bg-white hover:text-black">Abrir seguimiento en {ship.carrier} ↗</a>
                {ship.trackNumber && <span className="ml-2 text-white/40">Número: <span className="font-mono text-white/70 select-all">{ship.trackNumber}</span></span>}
              </div>
            )}
            {canEdit && <div className="pt-4"><ShipUpdate key={ship.id} ship={ship} /></div>}
            <div className="p-4">
              <div className="text-[10px] tracking-[0.3em] text-white/40 mb-3">CARGA · {ship.vehicles.length}</div>
              <div className="space-y-3">
                {ship.vehicles.map((c) => (
                  <button key={c.id} onClick={() => setCar(c)} className="w-full text-left border border-white/15 hover:border-white overflow-hidden">
                    <div className="aspect-[16/9] bg-white/5 grid place-items-center text-xs text-white/35">
                      {c.photo /* eslint-disable-next-line @next/next/no-img-element */ ? <img src={c.photo} alt={c.title} className="w-full h-full object-cover" /> : "Sin foto principal"}
                    </div>
                    <div className="p-3">
                      <div className="text-sm">{c.title}</div>
                      <div className="font-mono text-xs text-white/50 mt-0.5">{c.identifier}</div>
                      <div className="text-[11px] text-white/40 mt-1">BL {c.bl ?? "pendiente"} · {c.booking}{c.container ? ` · ${c.container}` : ""}</div>
                      {c.notes && <div className="text-[11px] text-amber-200/80 mt-1">{c.notes}</div>}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </aside>
        )}
      </div>

      {car && <VehicleDrawer car={car} canEdit={canEdit} onClose={() => setCar(null)} />}
    </div>
  );
}
