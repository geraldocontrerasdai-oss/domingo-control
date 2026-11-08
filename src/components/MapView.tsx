"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

type View = { x: number; y: number; w: number; h: number };
const FULL: View = { x: 0, y: 0, w: W, h: H };
const MIN_W = 24;
const clampView = (v: View): View => {
  const w = Math.min(W, Math.max(MIN_W, v.w)), h = w * H / W;
  return { w, h, x: Math.min(W - w, Math.max(0, v.x)), y: Math.min(H - h, Math.max(0, v.y)) };
};

export default function MapView({ data }: { data: MapData }) {
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [car, setCar] = useState<VehicleCard | null>(null);
  const [guide, setGuide] = useState(true);
  const [view, setViewState] = useState<View>(FULL);
  const [anchor, setAnchor] = useState<{ x: number; y: number; right: boolean } | null>(null);
  const viewRef = useRef<View>(FULL);
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const raf = useRef(0);
  const press = useRef<{ x: number; y: number; id: number } | null>(null);
  const dragged = useRef(false);
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const canEdit = data.role === "admin" || data.role === "operaciones";

  const setView = useCallback((v: View) => { const c = clampView(v); viewRef.current = c; setViewState(c); }, []);
  const k = W / view.w; // factor de acercamiento: los marcadores se mantienen del mismo tamaño en pantalla
  const ship = useMemo(() => data.ships.find((s) => s.id === sel) ?? null, [data.ships, sel]);
  const hov = useMemo(() => data.ships.find((s) => s.id === hover) ?? null, [data.ships, hover]);
  const total = data.ships.reduce((n, s) => n + s.vehicles.length, 0);
  const [selO, setSelO] = useState<string | null>(null);
  const [hovO, setHovO] = useState<string | null>(null);
  const org = useMemo(() => data.origins.find((o) => o.id === selO) ?? null, [data.origins, selO]);
  const horg = useMemo(() => data.origins.find((o) => o.id === hovO) ?? null, [data.origins, hovO]);
  const inOrigin = data.origins.reduce((n, o) => n + o.vehicles.length, 0);

  const px = (s: ShipView) => ({ x: s.pos.x * 10, y: s.pos.y * 5.2 });

  // Posición en pantalla ↔ coordenadas del mapa (el mapa se ajusta al recuadro sin deformarse)
  const geom = useCallback(() => {
    const r = svgRef.current!.getBoundingClientRect(), v = viewRef.current;
    const sc = Math.min(r.width / v.w, r.height / v.h);
    return { r, v, sc, ox: (r.width - v.w * sc) / 2, oy: (r.height - v.h * sc) / 2 };
  }, []);
  const toMap = useCallback((cx: number, cy: number) => {
    const { r, v, sc, ox, oy } = geom();
    return { x: v.x + (cx - r.left - ox) / sc, y: v.y + (cy - r.top - oy) / sc };
  }, [geom]);

  const zoomAt = useCallback((factor: number, mx: number, my: number) => {
    const v = viewRef.current;
    const w = Math.min(W, Math.max(MIN_W, v.w * factor)), f = w / v.w;
    setView({ w, h: w * H / W, x: mx - (mx - v.x) * f, y: my - (my - v.y) * f });
  }, [setView]);
  const zoomCenter = (factor: number) => { const v = viewRef.current; zoomAt(factor, v.x + v.w / 2, v.y + v.h / 2); };

  const flyTo = useCallback((t: View) => {
    cancelAnimationFrame(raf.current);
    const from = viewRef.current, t0 = performance.now(), dur = 450;
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      setView({ x: from.x + (t.x - from.x) * e, y: from.y + (t.y - from.y) * e, w: from.w + (t.w - from.w) * e, h: from.h + (t.h - from.h) * e });
      if (p < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  }, [setView]);

  const focusOn = useCallback((x: number, y: number, withPanel: boolean) => {
    const w = Math.min(viewRef.current.w, 240), h = w * H / W;
    const g = geom();
    const shift = withPanel ? 190 / Math.min(g.r.width / w, g.r.height / h) : 0; // el panel derecho (380 px) tapa la mitad: se centra en el resto
    flyTo({ x: x + shift - w / 2, y: y - h / 2, w, h });
  }, [flyTo, geom]);
  const fitAll = () => {
    const xs = [...data.ships.map((s) => px(s).x), ...data.origins.map((o) => o.pos.x * 10)];
    const ys = [...data.ships.map((s) => px(s).y), ...data.origins.map((o) => o.pos.y * 5.2)];
    if (!xs.length) return flyTo(FULL);
    const pad = 60, x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
    const w = Math.max(MIN_W, x1 - x0, (y1 - y0) * W / H), h = w * H / W;
    flyTo({ x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2, w, h });
  };

  // Rueda del ratón: acerca o aleja hacia donde está el cursor
  useEffect(() => {
    const el = svgRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); cancelAnimationFrame(raf.current);
      const m = toMap(e.clientX, e.clientY);
      zoomAt(Math.exp(e.deltaY * 0.0015), m.x, m.y);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [toMap, zoomAt]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  // Arrastrar para moverse; con dos dedos, pellizcar para acercar
  const onDown = (e: React.PointerEvent) => {
    cancelAnimationFrame(raf.current);
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    press.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    dragged.current = false;
  };
  const onMove = (e: React.PointerEvent) => {
    const prev = pts.current.get(e.pointerId);
    if (!prev) return;
    const now = { x: e.clientX, y: e.clientY };
    if (pts.current.size === 2) {
      const other = [...pts.current.entries()].find(([id]) => id !== e.pointerId)![1];
      const d0 = Math.hypot(prev.x - other.x, prev.y - other.y), d1 = Math.hypot(now.x - other.x, now.y - other.y);
      pts.current.set(e.pointerId, now);
      if (d0 > 0 && d1 > 0) { const m = toMap((now.x + other.x) / 2, (now.y + other.y) / 2); zoomAt(d0 / d1, m.x, m.y); }
      dragged.current = true; return;
    }
    if (!press.current || press.current.id !== e.pointerId) return;
    if (!dragged.current && Math.hypot(now.x - press.current.x, now.y - press.current.y) < 5) return;
    if (!dragged.current) { dragged.current = true; (e.currentTarget as Element).setPointerCapture(e.pointerId); setAnchor(null); setHover(null); setHovO(null); }
    const { sc } = geom(), v = viewRef.current;
    pts.current.set(e.pointerId, now);
    setView({ ...v, x: v.x - (now.x - prev.x) / sc, y: v.y - (now.y - prev.y) / sc });
  };
  const onUp = (e: React.PointerEvent) => {
    pts.current.delete(e.pointerId);
    if (press.current?.id === e.pointerId) press.current = null;
    if (dragged.current) setTimeout(() => { dragged.current = false; }, 0); // evita que el arrastre cuente como clic
  };

  // Marcadores que caen casi en el mismo punto (varios buques en un puerto) se abren en abanico
  const spot = useMemo(() => {
    const items = [
      ...data.ships.map((s) => ({ id: "s" + s.id, x: s.pos.x * 10, y: s.pos.y * 5.2 })),
      ...data.origins.map((o) => ({ id: "o" + o.id, x: o.pos.x * 10, y: o.pos.y * 5.2 + 20 / k })),
    ];
    const cell = 24 / k, groups = new Map<string, typeof items>();
    for (const it of items) { const key = `${Math.round(it.x / cell)}_${Math.round(it.y / cell)}`; groups.set(key, [...(groups.get(key) ?? []), it]); }
    const out = new Map<string, { x: number; y: number }>();
    for (const g of groups.values()) {
      if (g.length === 1) { out.set(g[0].id, { x: g[0].x, y: g[0].y }); continue; }
      const cx = g.reduce((n, i) => n + i.x, 0) / g.length, cy = g.reduce((n, i) => n + i.y, 0) / g.length;
      const R = (g.length === 2 ? 13 : 12 + g.length * 2.4) / k;
      g.forEach((it, i) => { const a = -Math.PI / 2 + (2 * Math.PI * i) / g.length; out.set(it.id, { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R }); });
    }
    return out;
  }, [data.ships, data.origins, k]);

  const showCard = (e: React.MouseEvent) => {
    const r = wrapRef.current!.getBoundingClientRect();
    setAnchor({ x: e.clientX - r.left, y: e.clientY - r.top, right: e.clientX - r.left > r.width * 0.6 });
  };
  const cardStyle = (a: { x: number; y: number; right: boolean }): React.CSSProperties => {
    const h = wrapRef.current?.getBoundingClientRect().height ?? 600;
    return { left: a.right ? a.x - 16 : a.x + 16, top: Math.max(8, Math.min(a.y - 12, h - 340)), transform: a.right ? "translateX(-100%)" : undefined };
  };
  const pickShip = (id: string) => { setSel(id); setSelO(null); const sh = data.ships.find((x) => x.id === id); if (sh) { const p = spot.get("s" + id) ?? px(sh); focusOn(p.x, p.y, true); } };
  const pickOrigin = (id: string) => { setSelO(id); setSel(null); const o = data.origins.find((x) => x.id === id); if (o) { const p = spot.get("o" + id) ?? { x: o.pos.x * 10, y: o.pos.y * 5.2 }; focusOn(p.x, p.y, true); } };

  return (
    <div className="h-screen flex flex-col bg-black text-white overflow-hidden">
      <AppNav role={data.role} info={`${data.ships.length} buques · ${total} vehículos en ruta${inOrigin ? ` · ${inOrigin} en origen` : ""}${data.unassigned ? ` · ${data.unassigned} sin embarque` : ""} · seguimiento ${data.lastRun ? ago(data.lastRun) : "sin ejecutar"}`} />

      <div ref={wrapRef} className="relative flex-1 min-h-0">
        <svg ref={svgRef} viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} preserveAspectRatio="xMidYMid meet"
          className="absolute inset-0 w-full h-full touch-none cursor-grab active:cursor-grabbing select-none"
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          onDoubleClick={(e) => { const m = toMap(e.clientX, e.clientY); zoomAt(0.5, m.x, m.y); }}
          onClick={() => { if (dragged.current) return; setSel(null); setSelO(null); }}>
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
            <g key={p.name} transform={`translate(${p.x * 10} ${p.y * 5.2})`}>
              <circle r={2.6 / k} fill="#000" stroke="#fff" strokeWidth={1 / k} />
              <text x={5 / k} y={-5 / k} fontSize={9 / k} fill="#fff" fillOpacity="0.6" letterSpacing="0.05em">{p.name}</text>
            </g>
          ))}

          {data.ships.map((s) => {
            const { x, y } = spot.get("s" + s.id) ?? px(s);
            const r = 10 / k;
            const dim = (sel && sel !== s.id) ? 0.3 : 1;
            return (
              <g key={s.id} transform={`translate(${x} ${y})`} opacity={dim} className="cursor-pointer"
                onMouseEnter={(e) => { setHover(s.id); showCard(e); }} onMouseMove={showCard} onMouseLeave={() => { setHover(null); setAnchor(null); }}
                onClick={(e) => { e.stopPropagation(); if (dragged.current) return; setSel(s.id); setSelO(null); }}>
                <circle r={r * 2} fill="transparent" />
                {s.mode === "roro"
                  ? <rect x={-r} y={-r} width={r * 2} height={r * 2} fill="#000" stroke={s.color} strokeWidth={2 / k} />
                  : <circle r={r} fill="#000" stroke={s.color} strokeWidth={2 / k} />}
                <text textAnchor="middle" dy={r * 0.38} fontSize={r * 1.1} fontWeight="600" fill={s.color}>{s.num}</text>
              </g>
            );
          })}

          {data.origins.map((o) => {
            const p = spot.get("o" + o.id) ?? { x: o.pos.x * 10, y: o.pos.y * 5.2 + 20 / k };
            const r = 9 / k;
            const on = selO === o.id || hovO === o.id;
            return (
              <g key={o.id} transform={`translate(${p.x} ${p.y})`} className="cursor-pointer"
                onMouseEnter={(e) => { setHovO(o.id); showCard(e); }} onMouseMove={showCard} onMouseLeave={() => { setHovO(null); setAnchor(null); }}
                onClick={(e) => { e.stopPropagation(); if (dragged.current) return; setSelO(o.id); setSel(null); }}>
                <circle r={r * 2} fill="transparent" />
                <rect x={-r} y={-r} width={r * 2} height={r * 2} transform="rotate(45)" fill="#000" stroke="#fff" strokeWidth={(on ? 2.4 : 1.4) / k} />
                <text textAnchor="middle" dy={r * 0.36} fontSize={r * 1.05} fontWeight="600" fill="#fff">{o.vehicles.length}</text>
              </g>
            );
          })}
        </svg>

        {data.ships.length === 0 && data.origins.length === 0 && (
          <div className="absolute inset-0 grid place-items-center text-white/40 text-sm pointer-events-none">
            Todavía no hay embarques cargados.
          </div>
        )}

        {/* Guía de buques */}
        {!guide && <button onClick={() => setGuide(true)} className="absolute left-4 top-4 border border-white/30 bg-black/80 px-3 py-1.5 text-xs hover:bg-white hover:text-black">Mostrar guía de buques</button>}
        {guide && <div className="absolute left-4 top-4 w-64 max-h-[calc(100%-5rem)] overflow-y-auto border border-white/15 bg-black/80 backdrop-blur">
          <div className="px-3 py-2 text-[10px] tracking-[0.3em] text-white/50 border-b border-white/10 flex justify-between items-center sticky top-0 bg-black/90">GUÍA DE BUQUES<button onClick={() => setGuide(false)} className="text-white/60 hover:text-white tracking-normal text-xs">Ocultar ✕</button></div>
          {data.ships.map((s) => (
            <button key={s.id} onClick={() => pickShip(s.id)} onMouseEnter={() => setHover(s.id)} onMouseLeave={() => setHover(null)}
              className={`w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-white/10 ${sel === s.id ? "bg-white/10" : ""}`}>
              <span className="w-6 h-6 grid place-items-center text-xs shrink-0" style={{ border: `1.5px solid ${s.color}`, color: s.color, borderRadius: s.mode === "roro" ? 0 : 999 }}>{s.num}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm truncate">{s.name}</span>
                <span className="block text-[11px] text-white/45 truncate">{s.vehicles.length} veh. · ETA {shortDate(s.eta)}</span>
              </span>
            </button>
          ))}
          {data.origins.length > 0 && <div className="px-3 py-2 text-[10px] tracking-[0.3em] text-white/50 border-t border-white/10">EN ORIGEN · SIN BL</div>}
          {data.origins.map((o) => (
            <button key={o.id} onClick={() => pickOrigin(o.id)} onMouseEnter={() => setHovO(o.id)} onMouseLeave={() => setHovO(null)}
              className={`w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-white/10 ${selO === o.id ? "bg-white/10" : ""}`}>
              <span className="w-6 h-6 grid place-items-center text-xs shrink-0 border border-white/70 rotate-45 scale-75"><span className="-rotate-45">{o.vehicles.length}</span></span>
              <span className="min-w-0 flex-1 text-sm truncate">{o.name}</span>
            </button>
          ))}
          <div className="px-3 py-2 text-[10px] text-white/35 border-t border-white/10">Sin AIS: posición según el último evento de la naviera.</div>
        </div>}

        <div className="absolute left-4 bottom-4 flex items-stretch gap-2 text-xs">
          <div className="flex border border-white/30 bg-black/80">
            <button onClick={() => zoomCenter(0.6)} aria-label="Acercar" className="w-9 py-1.5 text-base hover:bg-white hover:text-black">+</button>
            <button onClick={() => zoomCenter(1 / 0.6)} aria-label="Alejar" className="w-9 py-1.5 text-base border-l border-white/30 hover:bg-white hover:text-black">−</button>
          </div>
          <button onClick={() => flyTo(FULL)} className="border border-white/30 bg-black/80 px-3 hover:bg-white hover:text-black">Mundo</button>
          <button onClick={fitAll} className="border border-white/30 bg-black/80 px-3 hover:bg-white hover:text-black">Ver todos</button>
          <button onClick={() => flyTo({ x: CARIBE.x, y: CARIBE.y, w: CARIBE.w, h: CARIBE.h })} className="border border-white/30 bg-black/80 px-3 hover:bg-white hover:text-black">Caribe</button>
        </div>
        <div className="hidden lg:block absolute right-4 bottom-4 text-[10px] text-white/30 pointer-events-none select-none">Rueda: zoom · Arrastra: mover · Doble clic: acercar</div>

        {/* Ventana al pasar el cursor: carga del buque */}
        {hov && !ship && anchor && (
          <div className="absolute z-20 w-72 border border-white/25 bg-black/95 pointer-events-none" style={cardStyle(anchor)}>
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

        {horg && !org && !ship && anchor && (
          <div className="absolute z-20 w-72 border border-white/25 bg-black/95 pointer-events-none max-h-[70%] overflow-hidden" style={cardStyle(anchor)}>
            <div className="px-3 py-2 border-b border-white/10">
              <div className="text-sm">{horg.name}</div>
              <div className="text-[11px] text-white/50">{horg.vehicles.length} vehículos comprados, aún en origen</div>
            </div>
            {horg.vehicles.slice(0, 6).map((c) => (
              <div key={c.id} className="flex gap-2 px-3 py-1.5 border-b border-white/5 last:border-0">
                <Thumb car={c} size={36} />
                <div className="min-w-0 text-[11px]">
                  <div className="text-[12px] truncate">{c.title}</div>
                  <div className="font-mono text-white/50 truncate">{c.identifier}</div>
                </div>
              </div>
            ))}
            {horg.vehicles.length > 6 && <div className="px-3 py-1.5 text-[11px] text-white/40">y {horg.vehicles.length - 6} más…</div>}
          </div>
        )}

        {org && (
          <aside className="absolute right-0 top-0 bottom-0 w-[380px] max-w-full border-l border-white/15 bg-black/95 overflow-y-auto z-30">
            <div className="p-4 border-b border-white/10 flex justify-between items-start">
              <div>
                <div className="text-[10px] tracking-[0.3em] text-white/60">EN ORIGEN · SIN BL</div>
                <h2 className="text-lg mt-1">{org.name}</h2>
                <div className="text-xs text-white/50">{org.vehicles.length} vehículos comprados, esperando reserva</div>
              </div>
              <button onClick={() => setSelO(null)} className="text-white/50 hover:text-white text-sm">✕</button>
            </div>
            <div className="p-4 space-y-3">
              {org.vehicles.map((c) => (
                <button key={c.id} onClick={() => setCar(c)} className="w-full text-left border border-white/15 hover:border-white overflow-hidden flex">
                  <div className="w-24 shrink-0 bg-white/5 grid place-items-center text-[10px] text-white/35">
                    {c.photo /* eslint-disable-next-line @next/next/no-img-element */ ? <img src={c.photo} alt={c.title} className="w-full h-full object-cover" /> : "sin foto"}
                  </div>
                  <div className="p-3 min-w-0">
                    <div className="text-sm truncate">{c.title}{c.color ? <span className="text-white/40"> · {c.color}</span> : null}</div>
                    <div className="font-mono text-xs text-white/50 mt-0.5">{c.identifier}</div>
                    {c.provisional && <div className="text-[11px] text-amber-200/80 mt-1">Chasis por asignar</div>}
                  </div>
                </button>
              ))}
            </div>
          </aside>
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
