import { createHash } from "crypto";
import { createClient as createJs, type SupabaseClient } from "@supabase/supabase-js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN!;
export const tgConfigured = () => !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
// El secreto del webhook se deriva del token: no hace falta otra variable.
export const webhookSecret = () => createHash("sha256").update("domingo-control:" + TOKEN()).digest("hex");

export async function tg(method: string, body?: Record<string, unknown>): Promise<any> {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN()}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
  });
  return r.json();
}
export const say = (chat: number, text: string, extra: Record<string, unknown> = {}) =>
  tg("sendMessage", { chat_id: chat, text: text.slice(0, 4000), ...extra });

export async function download(fileId: string): Promise<{ buf: Buffer; path: string } | { error: string }> {
  const f = await tg("getFile", { file_id: fileId });
  if (!f.ok) return { error: f.description ?? "No pude descargar el archivo" };
  const r = await fetch(`https://api.telegram.org/file/bot${TOKEN()}/${f.result.file_path}`);
  if (!r.ok) return { error: "No pude descargar el archivo" };
  return { buf: Buffer.from(await r.arrayBuffer()), path: f.result.file_path };
}

// Cliente con permisos totales: SOLO para guardar el estado del bot y emitir la sesión del usuario.
export const adminClient = (): SupabaseClient =>
  createJs(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

// Cliente que actúa COMO el usuario emparejado: respeta sus permisos (RLS) y el historial queda a su nombre.
export async function asUser(email: string): Promise<SupabaseClient> {
  const { data, error } = await adminClient().auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data?.properties?.hashed_token) throw new Error(error?.message ?? "No se pudo abrir la sesión del usuario");
  const sb = createJs(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: e2 } = await sb.auth.verifyOtp({ token_hash: data.properties.hashed_token, type: "magiclink" });
  if (e2) throw new Error(e2.message);
  return sb;
}

// Estado del bot (vehículo activo, sesión, documentos por confirmar) en un bucket PRIVADO sin políticas:
// solo el servidor (clave de servicio) puede leerlo. No se usa la tabla settings porque la lee cualquier usuario.
const BUCKET = "bot-state";
let ready = false;
async function bucket() {
  const st = adminClient().storage;
  if (!ready) { await st.createBucket(BUCKET, { public: false }).catch(() => {}); ready = true; }
  return st.from(BUCKET);
}
export async function getState<T>(key: string): Promise<T | null> {
  const b = await bucket();
  const { data } = await b.download(`${key}.json`);
  if (!data) return null;
  try { return JSON.parse(await data.text()) as T; } catch { return null; }
}
export async function setState(key: string, value: unknown) {
  const b = await bucket();
  return b.upload(`${key}.json`, JSON.stringify(value), { contentType: "application/json", upsert: true });
}
export async function delState(key: string) {
  const b = await bucket();
  return b.remove([`${key}.json`]);
}
// true solo para quien lo reclama primero (sirve para que un álbum de 20 fotos responda una sola vez)
export async function claim(key: string): Promise<boolean> {
  const b = await bucket();
  const { error } = await b.upload(`${key}.json`, "{}", { contentType: "application/json", upsert: false });
  return !error;
}
