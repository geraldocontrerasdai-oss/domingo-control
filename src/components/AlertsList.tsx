"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { AlertItem, Priority } from "@/lib/alerts";

const COLOR: Record<Priority, string> = { alta: "#fca5a5", media: "#fde68a", baja: "#7dd3fc" };

export default function AlertsList({ items }: { items: AlertItem[] }) {
  const router = useRouter();
  const [p, setP] = useState<Priority | "">("");
  const [msg, setMsg] = useState("");
  async function act(body: object, ok: string, ask?: string) {
    if (ask && !confirm(ask)) return;
    const r = await fetch("/api/vehicles/merge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    setMsg(r.ok ? ok : j.error ?? `Error ${r.status}`);
    if (r.ok) router.refresh();
  }
  const rows = useMemo(() => items.filter((i) => !p || i.priority === p), [items, p]);
  const count = (x: Priority) => items.filter((i) => i.priority === x).length;
  return (
    <div className="max-w-5xl mx-auto p-6 text-white">
      <div className="flex gap-2 mb-4 text-sm">
        {([["", "Todas", items.length], ["alta", "Urgentes", count("alta")], ["media", "Importantes", count("media")], ["baja", "Menores", count("baja")]] as [Priority | "", string, number][]).map(([k, l, n]) => (
          <button key={k} onClick={() => setP(k)} className={`border px-3 py-1.5 ${p === k ? "bg-white text-black border-white" : "border-white/30 hover:border-white"}`}>{l} · {n}</button>
        ))}
      </div>
      {msg && <p className="mb-3 text-sm text-white/80">{msg}</p>}
      {rows.length === 0 && <div className="border border-white/10 p-8 text-center text-white/40 text-sm">Sin alertas. Todo en orden.</div>}
      <div className="border border-white/10">
        {rows.map((a) => (
          <div key={a.id} className="flex gap-4 px-4 py-3 border-b border-white/5 last:border-0">
            <span className="mt-1.5 w-2 h-2 rounded-full shrink-0" style={{ background: COLOR[a.priority] }} />
            <div className="min-w-0 flex-1">
              <div className="text-sm">{a.title}</div>
              <div className="text-xs text-white/50 mt-0.5">{a.detail}</div>
              <div className="text-xs mt-1" style={{ color: COLOR[a.priority] }}>→ {a.action}</div>
              {a.dup && (
                <div className="flex flex-wrap gap-2 mt-2 text-xs">
                  <button onClick={() => act({ keep: a.dup!.a.id, drop: a.dup!.b.id }, "Fusionados.", `¿Conservar ${a.dup!.a.identifier} y archivar ${a.dup!.b.identifier}? Las fotos y documentos pasan al conservado.`)} className="border border-white/40 px-2 py-1 hover:bg-white hover:text-black">Es correcto …{a.dup.a.identifier.slice(0, 9)}</button>
                  <button onClick={() => act({ keep: a.dup!.b.id, drop: a.dup!.a.id }, "Fusionados.", `¿Conservar ${a.dup!.b.identifier} y archivar ${a.dup!.a.identifier}? Las fotos y documentos pasan al conservado.`)} className="border border-white/40 px-2 py-1 hover:bg-white hover:text-black">Es correcto …{a.dup.b.identifier.slice(0, 9)}</button>
                  <button onClick={() => act({ ignore: [a.dup!.a.id, a.dup!.b.id] }, "Anotado: son vehículos distintos.")} className="border border-white/20 px-2 py-1 text-white/60 hover:border-white">Son distintos</button>
                </div>
              )}
              {a.rule === "Sin factura" && a.vehicleId && <button onClick={() => act({ confirm: a.vehicleId }, "Marcado como confirmado.", "¿Confirmar este vehículo sin subir la factura? Hazlo solo si ya sabes que el chasis es correcto.")} className="mt-2 text-xs border border-white/20 px-2 py-1 text-white/60 hover:border-white">Ya lo verifiqué, confirmar</button>}
            </div>
            <div className="text-right shrink-0">
              <div className="text-[10px] tracking-widest text-white/40">{a.rule.toUpperCase()}</div>
              {a.ref && <Link href={`/vehiculos?q=${encodeURIComponent(a.ref)}`} className="font-mono text-[11px] text-white/60 hover:text-white">{a.ref}</Link>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
