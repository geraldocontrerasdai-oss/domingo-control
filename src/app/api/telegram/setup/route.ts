import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { adminClient, getState, setState, tg, webhookSecret } from "@/lib/telegram";

/* eslint-disable @typescript-eslint/no-explicit-any */
const text = (s: string, status = 200) => new NextResponse(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

// Solo un admin con sesión abierta puede conectar el bot.
//  /api/telegram/setup              → revisa qué falta y lista quién le ha escrito al bot
//  /api/telegram/setup?pair=ID      → autoriza ese ID de Telegram (con tu correo) y activa el bot
//  /api/telegram/setup?pair=ID&email=otro@correo → autoriza a otro usuario de la plataforma
export async function GET(req: Request) {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return text("Inicia sesión primero.", 401);
  const { data: prof } = await sb.from("profiles").select("role").eq("id", user.id).single();
  if (prof?.role !== "admin") return text("Solo un administrador puede configurar el bot.", 403);

  const missing = ["TELEGRAM_BOT_TOKEN", "SUPABASE_SERVICE_ROLE_KEY"].filter((k) => !process.env[k]);
  if (missing.length) return text(`Faltan variables en Vercel: ${missing.join(", ")}.\nAgrégalas en Settings → Environment Variables y haz Redeploy.`);

  const url = new URL(req.url);
  const me = await tg("getMe");
  if (!me.ok) return text(`El token del bot no es válido: ${me.description}`);
  const info = (await tg("getWebhookInfo")).result;
  const pair = url.searchParams.get("pair");
  const users = (await getState<Record<string, { email: string }>>("telegram_users")) ?? {};

  if (!pair) {
    const out = [`Bot: @${me.result.username}`, `Webhook: ${info?.url ? "activo → " + info.url : "no activo todavía"}`, `Usuarios autorizados: ${Object.keys(users).length}`];
    if (!info?.url) {
      const up = await tg("getUpdates", { limit: 20 });
      const seen = new Map<number, string>();
      for (const u of up.result ?? []) { const f = u.message?.from; if (f) seen.set(f.id, `${f.first_name ?? ""} ${f.last_name ?? ""}${f.username ? " @" + f.username : ""}`.trim()); }
      out.push("", seen.size ? "Han escrito al bot:" : "Nadie le ha escrito al bot todavía: abre Telegram, búscalo y mándale un mensaje.");
      for (const [id, name] of seen) out.push(`  ID ${id} — ${name}  →  ${url.origin}/api/telegram/setup?pair=${id}`);
    }
    return text(out.join("\n"));
  }

  if (!/^\d+$/.test(pair)) return text("El ID de Telegram debe ser un número.", 400);
  const email = (url.searchParams.get("email") ?? user.email)!.toLowerCase();
  const { data: p } = await adminClient().from("profiles").select("id, role").eq("email", email).maybeSingle();
  if (url.searchParams.get("email") && !p) return text(`No hay ningún usuario de la plataforma con el correo ${email}.`, 404);
  users[pair] = { email };
  await setState("telegram_users", users);

  const hook = await tg("setWebhook", { url: `${url.origin}/api/telegram`, secret_token: webhookSecret(), allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
  if (!hook.ok) return text(`No pude activar el webhook: ${hook.description}`);
  await tg("setMyCommands", { commands: [
    { command: "v", description: "Elegir vehículo (últimos dígitos del chasis o modelo)" },
    { command: "estado", description: "Estado del vehículo elegido" },
    { command: "alertas", description: "Alertas urgentes" },
    { command: "ayuda", description: "Qué puedo hacer" },
  ] });
  await tg("sendMessage", { chat_id: Number(pair), text: "✅ Conectado a Domingo Control. Escribe /ayuda para ver qué puedo hacer." });
  return text(`Listo. @${me.result.username} quedó conectado y el ID ${pair} autorizado como ${email}. Ya puedes escribirle.`);
}
