"use client";
import { useMemo, useState } from "react";
import type { VehicleCard } from "@/lib/map-data";
import { STAGES } from "@/lib/format";
import VehicleDrawer from "./VehicleDrawer";

type Row = VehicleCard & { vessel: string | null; alert: "alta" | "media" | "baja" | null; alertCount: number };
const DOT = { alta: "#fca5a5", media: "#fde68a", baja: "#7dd3fc" } as const;

export default function VehicleList({ cards, role, initialQuery }: { cards: Row[]; role: string; initialQuery?: string }) {
  const [q, setQ] = useState(initialQuery ?? "");
  const [stage, setStage] = useState("");
  const [flt, setFlt] = useState("");
  const [sel, setSel] = useState<Row | null>(null);
  const canEdit = role === "admin" || role === "operaciones";

  const rows = useMemo(() => {
    const t = q.trim().toUpperCase().replace(/O/g, "0");
    return cards.filter((c) => {
      if (stage && c.stage !== stage) return false;
      if (flt === "alerta" && !c.alert) return false;
      if (flt === "urgente" && c.alert !== "alta") return false;
      if (flt === "docs" && c.docs === "completo") return false;
      if (flt === "foto" && c.photo) return false;
      if (flt === "origen" && c.shipmentId) return false;
      if (!t) return true;
      // Busca por cualquier parte del chasis (por ejemplo, los últimos 6) o por modelo, buque, BL, booking
      const hay = `${c.identifier} ${c.title} ${c.vessel ?? ""} ${c.bl ?? ""} ${c.booking} ${c.container ?? ""}`.toUpperCase().replace(/O/g, "0");
      return hay.includes(t);
    });
  }, [cards, q, stage, flt]);

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex flex-wrap gap-3 items-center">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por chasis (completo o los últimos dígitos), modelo, buque, BL…"
          className="flex-1 min-w-72 bg-black border border-white/30 px-3 py-2 text-sm outline-none focus:border-white" />
        <select value={stage} onChange={(e) => setStage(e.target.value)} className="bg-black border border-white/30 px-3 py-2 text-sm">
          <option value="">Todas las etapas</option>
          {Object.entries(STAGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <span className="text-xs text-white/40">{rows.length} de {cards.length}</span>
      </div>
      <div className="flex flex-wrap gap-2 mt-3 text-xs">
        {([["", "Todos"], ["alerta", `Con alertas · ${cards.filter((c) => c.alert).length}`], ["urgente", `Urgentes · ${cards.filter((c) => c.alert === "alta").length}`],
          ["docs", "Documentos incompletos"], ["foto", "Sin foto"], ["origen", "En origen, sin embarque"]] as [string, string][]).map(([k, l]) => (
          <button key={k} onClick={() => setFlt(k)} className={`border px-2.5 py-1 ${flt === k ? "bg-white text-black border-white" : "border-white/25 text-white/70 hover:border-white"}`}>{l}</button>
        ))}
      </div>

      <div className="mt-4 border border-white/10">
        {rows.length === 0 && <div className="p-8 text-center text-white/40 text-sm">No hay vehículos que coincidan.</div>}
        {rows.map((c) => (
          <button key={c.id} onClick={() => setSel(c)} className="w-full text-left flex items-center gap-4 px-4 py-3 border-b border-white/5 last:border-0 hover:bg-white/5">
            <div className="w-20 h-14 shrink-0 bg-white/10 overflow-hidden grid place-items-center text-[9px] text-white/35">
              {c.photo /* eslint-disable-next-line @next/next/no-img-element */ ? <img src={c.photo} alt="" className="w-full h-full object-cover" /> : "sin foto"}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm truncate">{c.title}{c.color ? <span className="text-white/40"> · {c.color}</span> : null}</div>
              <div className="font-mono text-xs text-white/50">{c.identifier}</div>
            </div>
            <div className="hidden md:block w-56 text-xs text-white/45 truncate">{c.vessel ?? "Sin buque asignado"}<br />{c.bl ? `BL ${c.bl}` : c.booking}</div>
            <div className="text-xs w-36 text-right text-white/70">{STAGES[c.stage] ?? c.stage}
              {c.alert && <div className="mt-0.5" style={{ color: DOT[c.alert] }}>● {c.alertCount} {c.alertCount === 1 ? "alerta" : "alertas"}</div>}</div>
          </button>
        ))}
      </div>
      {sel && <VehicleDrawer car={sel} canEdit={canEdit} onClose={() => setSel(null)} />}
    </div>
  );
}
