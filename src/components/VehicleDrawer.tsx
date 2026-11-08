"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import type { VehicleCard } from "@/lib/map-data";
import DocChecklist from "@/components/DocChecklist";
import { BL_STATUS, DOCS, STAGES } from "@/lib/format";

type Doc = { id: string; doc_type: string; version: number; url: string; name: string };
type Media = { id: string; kind: "photo" | "video"; is_primary: boolean; url: string; caption: string | null };

const MAX_BYTES = 50 * 1024 * 1024; // tope del plan gratuito de Supabase

// Reduce las fotos del celular (5–10 MB) a ~300 KB sin pérdida visible, para cuidar el espacio.
async function shrink(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej()), "image/jpeg", 0.85));
  } catch {
    return file; // formato que el navegador no decodifica (p. ej. HEIC): se sube tal cual
  }
}

export default function VehicleDrawer({ car, canEdit, onClose }: { car: VehicleCard; canEdit: boolean; onClose: () => void }) {
  const router = useRouter();
  const [items, setItems] = useState<Media[]>([]);
  const [cur, setCur] = useState(0);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [docs, setDocs] = useState<Doc[]>([]);

  const load = useCallback(async () => {
    const sb = createClient();
    const { data } = await sb.from("vehicle_media")
      .select("id, kind, is_primary, storage_path, caption, created_at")
      .eq("vehicle_id", car.id).is("archived_at", null).order("created_at");
    const rows = data ?? [];
    const signed = rows.length ? (await sb.storage.from("vehicle-media").createSignedUrls(rows.map((r) => r.storage_path), 3600)).data ?? [] : [];
    const url = new Map(signed.map((s) => [s.path, s.signedUrl]));
    const list = rows.map((r) => ({ id: r.id, kind: r.kind, is_primary: r.is_primary, caption: r.caption, url: url.get(r.storage_path) ?? "" }));
    // La foto principal va primero
    list.sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
    setItems(list);
    setCur(0);
  }, [car.id]);

  const loadDocs = useCallback(async () => {
    const sb = createClient();
    const ors = [`vehicle_id.eq.${car.id}`, ...(car.shipmentId ? [`shipment_id.eq.${car.shipmentId}`] : [])].join(",");
    const { data } = await sb.from("documents").select("id, doc_type, version, storage_path").or(ors).eq("is_current", true).is("archived_at", null);
    const rows = data ?? [];
    const signed = rows.length ? (await sb.storage.from("documents").createSignedUrls(rows.map((r) => r.storage_path), 3600)).data ?? [] : [];
    const url = new Map(signed.map((s) => [s.path, s.signedUrl]));
    setDocs(rows.map((r) => ({ id: r.id, doc_type: r.doc_type, version: r.version, url: url.get(r.storage_path) ?? "", name: r.storage_path.split("/").pop()!.replace(/^[0-9a-f]{8}-/, "") })));
  }, [car.id, car.shipmentId]);

  useEffect(() => { load(); loadDocs(); }, [load, loadDocs]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true); setMsg("");
    const sb = createClient();
    let ok = 0;
    for (const file of Array.from(files)) {
      const isVideo = file.type.startsWith("video/");
      if (!isVideo && !file.type.startsWith("image/")) { setMsg(`${file.name}: solo fotos y videos.`); continue; }
      const body = isVideo ? file : await shrink(file);
      if (body.size > MAX_BYTES) { setMsg(`${file.name}: pesa más de 50 MB. Comprímelo y vuelve a subirlo.`); continue; }
      const type = isVideo ? file.type : body.type || file.type;
      const ext = isVideo ? (file.name.split(".").pop() ?? "mp4").toLowerCase() : type === "image/jpeg" ? "jpg" : (type.split("/")[1] ?? "jpg");
      const path = `${car.id}/${crypto.randomUUID()}.${ext}`;
      const up = await sb.storage.from("vehicle-media").upload(path, body, { contentType: type });
      if (up.error) { setMsg(`${file.name}: ${up.error.message}`); continue; }
      const ins = await sb.from("vehicle_media").insert({
        vehicle_id: car.id, kind: isVideo ? "video" : "photo", storage_path: path, content_type: type, size_bytes: body.size,
      });
      if (ins.error) { setMsg(`${file.name}: ${ins.error.message}`); continue; }
      ok++;
    }
    setBusy(false);
    if (ok) { setMsg(`${ok} archivo(s) subido(s).`); await load(); router.refresh(); }
  }

  async function makePrimary(id: string) {
    const { error } = await createClient().rpc("set_primary_media", { p_media_id: id });
    setMsg(error ? error.message : "Foto principal actualizada.");
    await load(); router.refresh();
  }

  async function archive(id: string) {
    if (!confirm("¿Quitar este archivo del expediente? Queda archivado, no se borra.")) return;
    const { error } = await createClient().rpc("archive_media", { p_media_id: id });
    setMsg(error ? error.message : "Archivo archivado.");
    await load(); router.refresh();
  }

  const m = items[cur];
  const FOLDERS: Record<string, string> = { bl_final: "BL", bl_draft: "BL (borrador)", gate_pass: "Gate Pass", crowley_tag: "Etiqueta Crowley", title: "Título", courier_receipt: "Guía de courier" };
  const rows: [string, string | null][] = [
    ["Chasis / VIN", car.identifier], ["Color", car.color], ["Origen", car.origin],
    ["Etapa", STAGES[car.stage] ?? car.stage], ["Documentos", DOCS[car.docs] ?? car.docs],
    ["Booking", car.booking], ["Contenedor", car.container], ["BL", car.bl ? `${car.bl} (${BL_STATUS[car.blStatus] ?? car.blStatus})` : "Pendiente"],
    ["Consignatario", car.consignee],
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex justify-end" onClick={onClose}>
      <div className="w-full max-w-5xl h-full bg-black border-l border-white/15 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between p-5 border-b border-white/10">
          <div>
            <div className="text-[10px] tracking-[0.3em] text-white/50">EXPEDIENTE{car.provisional ? " · PROVISIONAL" : ""}</div>
            <h2 className="text-xl mt-1">{car.title}</h2>
            <div className="text-white/50 text-sm font-mono mt-1">{car.identifier}</div>
          </div>
          <button onClick={onClose} className="border border-white/30 px-3 py-1 hover:bg-white hover:text-black">Cerrar</button>
        </div>

        <div className="grid md:grid-cols-[minmax(0,1fr)_320px] gap-0">
          <div className="p-5 min-w-0">
            <div className="h-[58vh] min-h-64 w-full bg-white/5 border border-white/10 grid place-items-center overflow-hidden">
              {!m ? <span className="text-white/40 text-sm">Todavía no hay fotos ni videos de este vehículo.</span>
                : m.kind === "video" ? <video key={m.id} src={m.url} controls className="w-full h-full object-contain" />
                : /* eslint-disable-next-line @next/next/no-img-element */ <img src={m.url} alt={car.title} className="w-full h-full object-contain" />}
            </div>

            {items.length > 0 && (
              <div className="flex gap-2 mt-3 overflow-x-auto pb-1 max-w-full">
                {items.map((it, i) => (
                  <button key={it.id} onClick={() => setCur(i)}
                    className={`relative shrink-0 w-24 h-16 border ${i === cur ? "border-white" : "border-white/20"} bg-white/5 overflow-hidden`}>
                    {it.kind === "video"
                      ? <div className="w-full h-full grid place-items-center text-xs text-white/70">▶ video</div>
                      : /* eslint-disable-next-line @next/next/no-img-element */ <img src={it.url} alt="" className="w-full h-full object-cover" />}
                    {it.is_primary && <span className="absolute left-0 bottom-0 bg-white text-black text-[9px] px-1">PRINCIPAL</span>}
                  </button>
                ))}
              </div>
            )}

            {canEdit && (
              <div className="mt-4 space-y-3">
                <label className={`inline-block border border-white px-4 py-2 cursor-pointer hover:bg-white hover:text-black ${busy ? "opacity-50 pointer-events-none" : ""}`}>
                  {busy ? "Subiendo…" : "Subir fotos o videos"}
                  <input type="file" multiple accept="image/*,video/*" className="hidden" onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
                </label>
                {m && (
                  <div className="flex gap-2 text-sm">
                    {m.kind === "photo" && !m.is_primary && <button onClick={() => makePrimary(m.id)} className="border border-white/40 px-3 py-1 hover:bg-white hover:text-black">Hacer foto principal</button>}
                    <button onClick={() => archive(m.id)} className="border border-white/20 text-white/60 px-3 py-1 hover:border-white">Quitar</button>
                  </div>
                )}
                <p className="text-xs text-white/40">La primera foto que subas es la principal y es la que se ve en el mapa y en las tarjetas. Videos de hasta 50 MB.</p>
              </div>
            )}
            {msg && <p className="mt-3 text-sm text-white/70">{msg}</p>}
          </div>

          <dl className="p-5 border-t md:border-t-0 md:border-l border-white/10 text-sm space-y-3">
            {rows.map(([k, v]) => (
              <div key={k}><dt className="text-[10px] tracking-[0.2em] text-white/40">{k.toUpperCase()}</dt><dd className="mt-0.5 break-words">{v || "—"}</dd></div>
            ))}
            <DocChecklist vehicleId={car.id} shipmentId={car.shipmentId} blStatus={car.blStatus} hasBooking={!!car.shipmentId && car.booking !== "Sin booking"} canEdit={canEdit} />
            <div>
              <dt className="text-[10px] tracking-[0.2em] text-white/40">CARPETA DE DOCUMENTOS</dt>
              <dd className="mt-1 space-y-1">
                {docs.length === 0 && <span className="text-white/40">Sin documentos guardados.</span>}
                {docs.map((x) => (
                  <a key={x.id} href={x.url} target="_blank" rel="noreferrer" className="block border border-white/15 px-2 py-1.5 hover:border-white">
                    <span className="block text-[11px] text-white/50">{FOLDERS[x.doc_type] ?? x.doc_type}{x.version > 1 ? ` · versión ${x.version}` : ""}</span>
                    <span className="block text-xs truncate">{x.name}</span>
                  </a>
                ))}
              </dd>
            </div>
            {car.notes && <div><dt className="text-[10px] tracking-[0.2em] text-white/40">NOTAS</dt><dd className="mt-0.5 text-amber-200/90">{car.notes}</dd></div>}
          </dl>
        </div>
      </div>
    </div>
  );
}
