import { NextResponse, after } from "next/server";
import { createHash, randomUUID } from "crypto";
import sharp from "sharp";
import { createClient as createJs, type SupabaseClient } from "@supabase/supabase-js";
import { adminClient, claim, delState, download, getState, say, setState, tg, tgConfigured, webhookSecret } from "@/lib/telegram";
import { analyzeDocument } from "@/lib/analyze";
import { getAlerts } from "@/lib/alerts";
import { normalizeVin } from "@/lib/vin";

export const maxDuration = 60;
/* eslint-disable @typescript-eslint/no-explicit-any */

const TYPES: Record<string, string> = {
  bl: "BL", invoice: "Factura (se lee y se descarta)", gate_pass: "Gate Pass", crowley_tag: "Etiqueta Crowley", title: "Título",
  courier_receipt: "Guía de courier", vehicle_photo: "Foto del vehículo", other: "Otro (no se guarda)",
};
const FOLDER: Record<string, string> = { bl: "bl", gate_pass: "gate-pass", crowley_tag: "etiqueta-crowley", title: "titulo", courier_receipt: "courier" };
const STAGES: Record<string, string> = {
  compra_confirmada: "Compra confirmada", recogido_origen: "Recogido en origen", con_reserva: "Con reserva",
  embarcado: "Embarcado", en_transito: "En tránsito", arribado: "Arribado",
};
const HELP = `Hola. Esto puedo hacer:

📸 Fotos y videos: elige el vehículo con /v y mándalas (o pon los últimos dígitos del chasis en la descripción de la foto).
📄 Documentos: reenvía un BL, título, Gate Pass, etiqueta de Crowley o guía de courier (PDF o foto). Leo los datos y te pido confirmar antes de guardar.

Comandos:
/v 200779 – elegir vehículo (últimos dígitos del chasis o modelo)
/estado – estado del vehículo elegido (o /estado 200779)
/alertas – lo urgente ahora
/ayuda – este mensaje`;

// ───────── sesión del usuario emparejado (con reintentos por si llegan 20 fotos a la vez) ─────────
async function userClient(tgId: number, email: string): Promise<SupabaseClient> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const key = `tg_session_${tgId}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const sb = createJs(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
    const saved = await getState<{ access_token: string; refresh_token: string }>(key);
    if (saved) {
      const { data, error } = await sb.auth.setSession(saved);
      if (!error && data.session) {
        if (data.session.access_token !== saved.access_token) await setState(key, { access_token: data.session.access_token, refresh_token: data.session.refresh_token });
        return sb;
      }
    }
    const { data: link, error } = await adminClient().auth.admin.generateLink({ type: "magiclink", email });
    if (!error && link?.properties?.hashed_token) {
      const { data, error: e2 } = await sb.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: "magiclink" });
      if (!e2 && data.session) {
        await setState(key, { access_token: data.session.access_token, refresh_token: data.session.refresh_token });
        return sb;
      }
    }
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 1200)); // otra foto del álbum pudo guardar ya la sesión
  }
  throw new Error("No pude abrir tu sesión en Domingo Control");
}

// ───────── vehículos ─────────
type Veh = { id: string; identifier: string; make: string | null; model: string | null; model_year: number | null; color: string | null };
const label = (v: Veh) => [v.model_year, v.make, v.model].filter(Boolean).join(" ") || "Vehículo";
const short = (v: Veh) => `${label(v)} · …${v.identifier.slice(-6)}`;

async function findVehicles(sb: SupabaseClient, text: string): Promise<Veh[]> {
  const q = text.trim().toUpperCase().replace(/O/g, "0");
  if (!q) return [];
  const { data } = await sb.from("vehicles").select("id, identifier, make, model, model_year, color").is("archived_at", null).limit(1000);
  const words = q.split(/\s+/).filter(Boolean);
  const compact = q.replace(/[^A-Z0-9]/g, "");
  return ((data ?? []) as Veh[]).filter((v) => {
    const hay = `${v.identifier} ${v.model_year ?? ""} ${v.make ?? ""} ${v.model ?? ""} ${v.color ?? ""}`.toUpperCase().replace(/O/g, "0");
    return v.identifier.includes(compact) && compact.length >= 3 || words.every((w) => hay.includes(w));
  });
}

async function activeVehicle(sb: SupabaseClient, chat: number): Promise<Veh | null> {
  const a = await getState<{ id: string }>(`tg_active_${chat}`);
  if (!a) return null;
  const { data } = await sb.from("vehicles").select("id, identifier, make, model, model_year, color").eq("id", a.id).maybeSingle();
  return (data as Veh) ?? null;
}
const setActive = (chat: number, v: Veh) => setState(`tg_active_${chat}`, { id: v.id });

async function chooseVehicle(sb: SupabaseClient, chat: number, text: string, then?: string) {
  const list = await findVehicles(sb, text);
  if (list.length === 0) return say(chat, `No encontré ningún vehículo con "${text}". Prueba con más dígitos del chasis o con el modelo.`);
  if (list.length === 1) {
    await setActive(chat, list[0]);
    return say(chat, `✅ Vehículo elegido:\n${label(list[0])}\n${list[0].identifier}\n\n${then ?? "Mándame las fotos o videos."}`);
  }
  const shown = list.slice(0, 8);
  return say(chat, `Encontré ${list.length} vehículos${list.length > 8 ? " (te muestro 8, afina la búsqueda para ver otros)" : ""}. Toca el correcto:`, {
    reply_markup: { inline_keyboard: shown.map((v) => [{ text: `${short(v)}`.slice(0, 60), callback_data: `v:${v.id}` }]) },
  });
}

// Solo el primer mensaje de un álbum responde; los demás guardan en silencio.
async function firstOfGroup(mgid?: string): Promise<boolean> {
  if (!mgid) return true;
  return claim(`tg_grp_${mgid}`);
}

// ───────── fotos y videos ─────────
async function saveMedia(sb: SupabaseClient, v: Veh, buf: Buffer, kind: "photo" | "video", contentType: string): Promise<string | null> {
  let body = buf, type = contentType;
  if (kind === "photo" && buf.length > 1_500_000) {
    try { body = await sharp(buf).rotate().resize({ width: 2200, height: 2200, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer(); type = "image/jpeg"; } catch {}
  }
  const ext = kind === "video" ? (contentType.split("/")[1] ?? "mp4").replace("quicktime", "mov") : type === "image/png" ? "png" : "jpg";
  const path = `${v.id}/${randomUUID()}.${ext}`;
  const up = await sb.storage.from("vehicle-media").upload(path, body, { contentType: type });
  if (up.error) return up.error.message;
  for (let i = 0; i < 3; i++) {
    const ins = await sb.from("vehicle_media").insert({ vehicle_id: v.id, kind, storage_path: path, content_type: type, size_bytes: body.length });
    if (!ins.error) return null;
    if (ins.error.code !== "23505") return ins.error.message; // 23505: dos fotos del álbum quisieron ser "principal" a la vez; se reintenta
    await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));
  }
  return "No pude registrar el archivo";
}

async function handleMedia(sb: SupabaseClient, chat: number, msg: any) {
  const mgid: string | undefined = msg.media_group_id;
  const caption: string = (msg.caption ?? "").trim();
  let v: Veh | null = null;
  if (caption) {
    const found = await findVehicles(sb, caption);
    if (found.length === 1) { v = found[0]; await setActive(chat, v); }
    else if (found.length > 1 && await firstOfGroup(mgid ? mgid + "c" : undefined)) { await chooseVehicle(sb, chat, caption); return; }
  }
  v = v ?? (await activeVehicle(sb, chat));
  if (!v) {
    if (await firstOfGroup(mgid ? mgid + "n" : undefined)) await say(chat, "¿De qué vehículo son? Elige uno con /v (por ejemplo /v 200779) y vuelve a mandarlas. También puedes poner los últimos dígitos del chasis en la descripción de la foto.");
    return;
  }
  const isVideo = !!msg.video || msg.document?.mime_type?.startsWith("video/");
  const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : (msg.video ?? msg.document).file_id;
  const got = await download(fileId);
  if ("error" in got) { await say(chat, isVideo ? "Ese video pesa más de 20 MB y Telegram no me deja bajarlo. Súbelo desde el expediente en la web." : got.error); return; }
  const ct = msg.photo ? "image/jpeg" : (msg.video?.mime_type ?? msg.document?.mime_type ?? (isVideo ? "video/mp4" : "image/jpeg"));
  const err = await saveMedia(sb, v, got.buf, isVideo ? "video" : "photo", ct);
  if (err) { await say(chat, `No pude guardar: ${err}`); return; }
  if (await firstOfGroup(mgid)) await say(chat, mgid ? `📸 Guardando el álbum en ${short(v)}. Con /estado ves cuántas hay.` : `${isVideo ? "🎥" : "📸"} Guardado en ${short(v)}.`);
}

// ───────── documentos ─────────
function summary(r: any): string {
  const sh = r.shipment ?? {};
  const lines = [`📄 ${TYPES[r.doc_type] ?? r.doc_type}${r.carrier_info?.name ? " · " + r.carrier_info.name : ""}`];
  const ids = [sh.booking_no && `Booking ${sh.booking_no}`, sh.bl_no && `BL ${sh.bl_no}${sh.bl_status ? ` (${sh.bl_status === "final" ? "definitivo" : "borrador"})` : ""}`].filter(Boolean);
  if (ids.length) lines.push(ids.join(" · "));
  if (sh.vessel) lines.push(`Buque ${sh.vessel}${sh.voyage ? " " + sh.voyage : ""}`);
  if (r.courier?.tracking_no) lines.push(`${String(r.courier.carrier ?? "").toUpperCase()} ${r.courier.tracking_no}`);
  lines.push(`\nVehículos (${r.vehicles.length}):`);
  for (const v of r.vehicles.slice(0, 12)) lines.push(`• ${v.vin}${[v.year, v.make, v.model].filter(Boolean).length ? " — " + [v.year, v.make, v.model].filter(Boolean).join(" ") : ""}${v.warnings?.length ? " ⚠️" : ""}`);
  if (r.vehicles.length > 12) lines.push(`…y ${r.vehicles.length - 12} más`);
  const warn = r.vehicles.flatMap((v: any) => (v.warnings ?? []).map((w: string) => `⚠️ ${v.vin}: ${w}`));
  if (warn.length) lines.push("\n" + warn.slice(0, 5).join("\n"));
  if (r.notes) lines.push(`\nNota de lectura: ${r.notes}`);
  return lines.join("\n");
}

async function handleDocument(sb: SupabaseClient, chat: number, msg: any) {
  const d = msg.document;
  const mime: string = d.mime_type === "image/jpg" ? "image/jpeg" : d.mime_type;
  if (!["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(mime)) { await say(chat, "Solo leo PDF o imágenes (JPG, PNG, WEBP)."); return; }
  const got = await download(d.file_id);
  if ("error" in got) { await say(chat, "Ese archivo pesa más de 20 MB. Comprímelo o súbelo desde la Bandeja."); return; }
  await say(chat, "Leyendo el documento…");
  let r: any;
  try {
    let buf = got.buf, mt = mime;
    if (mt.startsWith("image/") && buf.length > 4_000_000) { buf = await sharp(buf).rotate().resize({ width: 2400, height: 2400, fit: "inside" }).jpeg({ quality: 85 }).toBuffer(); mt = "image/jpeg"; }
    r = await analyzeDocument(buf, mt);
  } catch (e) { await say(chat, `No pude leerlo: ${e instanceof Error ? e.message : "error"}`); return; }

  // Una foto del vehículo enviada como archivo: va a la carpeta del vehículo elegido
  if (r.doc_type === "vehicle_photo") {
    const byVin = r.vehicles?.[0]?.vin ? (await findVehicles(sb, r.vehicles[0].vin))[0] : null;
    const v = byVin ?? (await activeVehicle(sb, chat));
    if (!v) { await say(chat, "Parece una foto de un vehículo. Elige cuál con /v y vuelve a mandarla."); return; }
    const err = await saveMedia(sb, v, got.buf, "photo", mime);
    await say(chat, err ? `No pude guardar: ${err}` : `📸 Guardada en ${short(v)}.`);
    return;
  }
  if (!r.vehicles?.length) { await say(chat, `No encontré ningún chasis en el documento.${r.notes ? "\n" + r.notes : ""}\nSúbelo desde la Bandeja si necesitas completarlo a mano.`); return; }
  const id = randomUUID();
  await setState(`tg_pend_${id}`, { chat, result: r, file_id: d.file_id, file_name: d.file_name ?? `documento.${mime === "application/pdf" ? "pdf" : "jpg"}`, mime, t: Date.now() });
  await say(chat, summary(r) + "\n\n¿Lo guardo?", { reply_markup: { inline_keyboard: [[{ text: "✅ Guardar", callback_data: `ok:${id}` }, { text: "✖ Descartar", callback_data: `no:${id}` }]] } });
}

async function commitPending(sb: SupabaseClient, chat: number, id: string) {
  const p = await getState<any>(`tg_pend_${id}`);
  if (!p) { await say(chat, "Ese documento ya se guardó o venció. Vuelve a enviarlo."); return; }
  const r = p.result;
  const vehicles = r.vehicles.filter((v: any) => v.vin).map((v: any) => ({ ...v, vin: normalizeVin(v.vin) }));
  let storage_path: string | undefined, hash: string | undefined;
  if (FOLDER[r.doc_type]) {
    const got = await download(p.file_id);
    if ("error" in got) { await say(chat, got.error); return; }
    hash = createHash("sha256").update(got.buf).digest("hex");
    const owner = r.doc_type === "bl" ? `embarques/${r.shipment?.bl_no || r.shipment?.booking_no || "sin-numero"}` : `vehiculos/${vehicles[0]?.vin ?? "sin-vin"}`;
    storage_path = `${owner}/${FOLDER[r.doc_type]}/${hash.slice(0, 8)}-${String(p.file_name).replace(/[^\w.\-]+/g, "_")}`;
    const up = await sb.storage.from("documents").upload(storage_path, got.buf, { contentType: p.mime, upsert: false });
    if (up.error && !/exists/i.test(up.error.message)) { await say(chat, `No pude guardar el archivo: ${up.error.message}`); return; }
  }
  const { data, error } = await sb.rpc("intake_commit", { p_items: [{ doc_type: r.doc_type, origin: r.origin, shipment: r.shipment, courier: r.courier, vehicles, storage_path, sha256: hash }] });
  if (error) { await say(chat, /sha256/.test(error.message) ? "Ese documento ya estaba cargado." : `No se pudo guardar: ${error.message}`); await delState(`tg_pend_${id}`); return; }
  await delState(`tg_pend_${id}`);
  const first = (await findVehicles(sb, vehicles[0].vin))[0];
  if (first) await setActive(chat, first);
  await say(chat, `✅ Guardado: ${data.vehicles_new} vehículo(s) nuevo(s), ${data.vehicles_updated} actualizado(s), ${data.shipments_new} embarque(s), ${data.documents} documento(s).${first ? `\n\nVehículo activo: ${short(first)}` : ""}`);
}

// ───────── consultas ─────────
async function estado(sb: SupabaseClient, chat: number, arg: string) {
  let v: Veh | null = null;
  if (arg) {
    const f = await findVehicles(sb, arg);
    if (f.length > 1) return chooseVehicle(sb, chat, arg, "Usa /estado otra vez.");
    v = f[0] ?? null;
    if (!v) return say(chat, `No encontré ningún vehículo con "${arg}".`);
  } else v = await activeVehicle(sb, chat);
  if (!v) return say(chat, "Elige un vehículo con /v o escribe /estado 200779.");
  const { data: c } = await sb.from("vehicles").select("stage, origin_place, shipment:shipments(booking_no, bl_no, bl_status, voyage_id, voyage:voyages(vessel:vessels(name)))").eq("id", v.id).single();
  const s: any = Array.isArray((c as any)?.shipment) ? (c as any).shipment[0] : (c as any)?.shipment;
  const voy: any = s ? (Array.isArray(s.voyage) ? s.voyage[0] : s.voyage) : null;
  const ves: any = voy ? (Array.isArray(voy.vessel) ? voy.vessel[0] : voy.vessel) : null;
  const [eta, ev, photos, al] = await Promise.all([
    s?.voyage_id ? sb.from("v_current_eta").select("eta").eq("voyage_id", s.voyage_id).maybeSingle() : null,
    s?.voyage_id ? sb.from("v_voyage_last_event").select("event_type, occurred_at, observed_at").eq("voyage_id", s.voyage_id).maybeSingle() : null,
    sb.from("vehicle_media").select("id", { count: "exact", head: true }).eq("vehicle_id", v.id).is("archived_at", null),
    getAlerts(sb),
  ]);
  const fin = ev?.data && ["arrived", "discharged"].includes((ev.data as any).event_type);
  const fecha = (iso: string) => new Date(iso).toLocaleDateString("es-DO", { day: "numeric", month: "short", timeZone: "UTC" });
  const out = [`${label(v)}${v.color ? " · " + v.color : ""}`, v.identifier, `Etapa: ${STAGES[(c as any)?.stage] ?? (c as any)?.stage}`];
  if (!s) out.push(`En origen${(c as any)?.origin_place ? ": " + (c as any).origin_place : ""} · sin embarque todavía`);
  else {
    out.push(`Buque: ${ves?.name ?? "sin asignar"} · ${s.bl_no ? "BL " + s.bl_no : "Booking " + s.booking_no}`);
    if (eta?.data && !fin) out.push(`ETA: ${fecha((eta.data as any).eta)}`);
    if (fin) out.push(`Descargado: ${fecha((ev!.data as any).occurred_at ?? (ev!.data as any).observed_at)}`);
  }
  out.push(`Fotos y videos: ${photos.count ?? 0}`);
  const mine = al.items.filter((a) => a.vehicleId === v!.id);
  out.push(mine.length ? "\nAlertas:\n" + mine.map((a) => `${a.priority === "alta" ? "🔴" : a.priority === "media" ? "🟡" : "🔵"} ${a.title}\n   → ${a.action}`).join("\n") : "\nSin alertas.");
  return say(chat, out.join("\n"));
}

async function alertas(sb: SupabaseClient, chat: number) {
  const { items } = await getAlerts(sb);
  const hot = items.filter((a) => a.priority === "alta");
  if (!hot.length) return say(chat, items.length ? `Sin urgentes. Hay ${items.length} alertas menores en la web.` : "Todo en orden, sin alertas.");
  const lines = hot.slice(0, 10).map((a) => `🔴 ${a.title}\n   ${a.detail}\n   → ${a.action}`);
  return say(chat, `${hot.length} urgente(s):\n\n${lines.join("\n\n")}${hot.length > 10 ? `\n\n…y ${hot.length - 10} más en la web.` : ""}`);
}

// ───────── entrada ─────────
async function handle(upd: any) {
  const cb = upd.callback_query;
  const msg = upd.message ?? upd.edited_message;
  const from: number | undefined = cb?.from?.id ?? msg?.from?.id;
  const chat: number | undefined = cb?.message?.chat?.id ?? msg?.chat?.id;
  if (!from || !chat) return;
  const users = (await getState<Record<string, { email: string }>>("telegram_users")) ?? {};
  const me = users[String(from)];
  if (!me) { await say(chat, `No estás autorizado en Domingo Control. Tu ID de Telegram es ${from}.`); return; }
  const sb = await userClient(from, me.email);

  if (cb) {
    await tg("answerCallbackQuery", { callback_query_id: cb.id });
    const [kind, arg] = String(cb.data).split(/:(.+)/);
    if (kind === "v") {
      const { data } = await sb.from("vehicles").select("id, identifier, make, model, model_year, color").eq("id", arg).maybeSingle();
      if (data) { await setActive(chat, data as Veh); await say(chat, `✅ Vehículo elegido:\n${label(data as Veh)}\n${(data as Veh).identifier}\n\nMándame las fotos o videos.`); }
    } else if (kind === "ok") await commitPending(sb, chat, arg);
    else if (kind === "no") { await delState(`tg_pend_${arg}`); await say(chat, "Descartado, no se guardó nada."); }
    return;
  }
  if (!msg) return;
  const text: string = (msg.text ?? "").trim();
  if (text.startsWith("/")) {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ");
    const c = cmd.toLowerCase().split("@")[0];
    if (c === "/start" || c === "/ayuda" || c === "/help") return void (await say(chat, HELP));
    if (c === "/v") return void (arg ? await chooseVehicle(sb, chat, arg) : await say(chat, "Escribe los últimos dígitos del chasis o el modelo, por ejemplo: /v 200779"));
    if (c === "/estado") return void (await estado(sb, chat, arg));
    if (c === "/alertas") return void (await alertas(sb, chat));
    return void (await say(chat, "No conozco ese comando. Mira /ayuda."));
  }
  if (msg.photo || msg.video || msg.document?.mime_type?.startsWith("video/")) return void (await handleMedia(sb, chat, msg));
  if (msg.document) return void (await handleDocument(sb, chat, msg));
  if (text) return void (await chooseVehicle(sb, chat, text)); // escribir un chasis a secas equivale a /v
}

export async function POST(req: Request) {
  if (!tgConfigured()) return NextResponse.json({ error: "Bot sin configurar" }, { status: 503 });
  if (req.headers.get("x-telegram-bot-api-secret-token") !== webhookSecret()) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const upd = await req.json();
  // Se responde a Telegram enseguida y el trabajo sigue en segundo plano (leer un documento tarda).
  after(async () => {
    try { await handle(upd); }
    catch (e) {
      const chat = upd.message?.chat?.id ?? upd.callback_query?.message?.chat?.id;
      if (chat) await say(chat, `Algo falló: ${e instanceof Error ? e.message : "error"}. Intenta de nuevo.`).catch(() => {});
    }
  });
  return NextResponse.json({ ok: true });
}
