import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { analyzeDocument } from "@/lib/analyze";

export const maxDuration = 60;

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function POST(req: Request) {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sin sesión" }, { status: 401 });
  const { data: prof } = await sb.from("profiles").select("role").eq("id", user.id).single();
  if (prof?.role !== "admin" && prof?.role !== "operaciones") return NextResponse.json({ error: "Sin permiso" }, { status: 403 });
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "Falta configurar ANTHROPIC_API_KEY en Vercel" }, { status: 500 });

  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "Falta el archivo" }, { status: 400 });
  const type = file.type === "image/jpg" ? "image/jpeg" : file.type;
  if (!["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(type))
    return NextResponse.json({ error: "Solo PDF o imágenes JPG/PNG/WEBP" }, { status: 400 });
  if (file.size > 4 * 1024 * 1024) return NextResponse.json({ error: "Pesa más de 4 MB. Comprímelo o sube una captura." }, { status: 413 });

  try {
    return NextResponse.json({ result: await analyzeDocument(Buffer.from(await file.arrayBuffer()), type) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error leyendo el documento" }, { status: 502 });
  }
}
