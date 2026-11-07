import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { normalizeVin, stripMoney, vinWarnings } from "@/lib/vin";
import { detectCarrier } from "@/lib/carriers";

export const maxDuration = 60;

const TOOL = {
  name: "report_document",
  description: "Devuelve lo que dice el documento. Nunca incluyas dinero.",
  input_schema: {
    type: "object",
    properties: {
      doc_type: { type: "string", enum: ["bl", "invoice", "gate_pass", "crowley_tag", "title", "courier_receipt", "vehicle_photo", "other"] },
      origin: { type: "string", enum: ["manheim", "japan", "other"], description: "Manheim = subasta de EE. UU.; japan = Japón; other = cualquier otro país" },
      vehicles: {
        type: "array",
        items: {
          type: "object",
          properties: {
            vin: { type: "string", description: "Chasis o VIN exactamente como aparece" },
            year: { type: "integer" }, make: { type: "string" }, model: { type: "string" }, color: { type: "string" },
            origin_place: { type: "string", description: "Lugar de origen/recogida o proveedor" },
            supplier: { type: "string", description: "Nombre del vendedor o shipper, sin datos bancarios" },
            container_no: { type: "string" },
          },
          required: ["vin"],
        },
      },
      shipment: {
        type: "object",
        properties: {
          booking_no: { type: "string" }, bl_no: { type: "string" }, bl_status: { type: "string", enum: ["draft", "final"], description: "draft si dice DRAFT/borrador/non-negotiable copy; final si es el BL original/definitivo" },
          mode: { type: "string", enum: ["container", "roro"] }, carrier: { type: "string" }, vessel: { type: "string" }, voyage: { type: "string" },
          port_loading: { type: "string" }, port_discharge: { type: "string" }, consignee: { type: "string" },
          containers: { type: "array", items: { type: "string" } },
        },
      },
      courier: {
        type: "object",
        properties: { carrier: { type: "string", enum: ["fedex", "dhl", "other"] }, tracking_no: { type: "string" }, kind: { type: "string", enum: ["titulo", "original_bl", "otro"] } },
      },
      notes: { type: "string", description: "Dudas de lectura (borroso, cortado, ilegible)" },
    },
    required: ["doc_type", "vehicles"],
  },
};

const PROMPT = `Eres un lector de documentos de importación de vehículos. Lee el documento y llama a report_document.
REGLAS ESTRICTAS:
- NUNCA extraigas precios, totales, pagos, montos, cuentas bancarias, IBAN, SWIFT ni ningún dato financiero, aunque estén en el documento. Ignóralos por completo.
- Copia los chasis/VIN exactamente como aparecen; no los corrijas ni los completes. Si algo está borroso, ponlo en notes.
- Un BL puede listar varios vehículos: extrae todos. Una factura o Gate Pass suele tener uno.
- En un BL, bl_status es "draft" si el documento dice DRAFT, borrador o copia no negociable.
- El documento puede ser de CUALQUIER naviera (MSC, ONE, Evergreen, Hapag-Lloyd, Maersk, CMA CGM, COSCO, OOCL, ZIM, Yang Ming, HMM, Crowley u otra). Cada una usa su propio formato: busca los datos por su significado, no por la posición. Los primeros 4 caracteres del número de BL suelen ser el código de la naviera.
- bl_status "final" si es el BL original o definitivo, o un Sea Waybill / Express Release; "draft" si dice DRAFT, borrador o copia no negociable.
- Si el BL tiene varias páginas o listas de contenedores, recorre todas. Un BL puede traer varios contenedores y muchos chasis.
- Si un dato no aparece, omítelo. No inventes.`;

async function ask(model: string, mediaType: string, b64: string) {
  const block = mediaType === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: mediaType, data: b64 } }
    : { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } };
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model, max_tokens: 4096, tools: [TOOL], tool_choice: { type: "tool", name: "report_document" },
      messages: [{ role: "user", content: [block, { type: "text", text: PROMPT }] }],
    }),
  });
  if (!r.ok) throw new Error(`IA ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const use = (j.content ?? []).find((c: { type: string }) => c.type === "tool_use");
  if (!use) throw new Error("La IA no devolvió datos");
  return use.input as Record<string, unknown>;
}

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

  const b64 = Buffer.from(await file.arrayBuffer()).toString("base64");
  try {
    // Modelo económico primero; si no encuentra ningún chasis, reintenta con el más capaz
    let out = await ask("claude-haiku-5-5", type, b64);
    if (!Array.isArray(out.vehicles) || out.vehicles.length === 0) out = await ask("claude-sonnet-5-5", type, b64);

    const clean: any = stripMoney(out);
    clean.vehicles = (clean.vehicles ?? []).map((v: any) => {
      const vin = normalizeVin(String(v.vin ?? ""));
      return { ...v, vin, warnings: vinWarnings(vin) };
    });
    if (clean.shipment?.containers) {
      clean.shipment.containers = clean.shipment.containers.map((c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, ""));
    }
    const sh = clean.shipment ?? {};
    const guess = detectCarrier(sh.carrier, sh.bl_no, sh.booking_no);
    clean.carrier_info = { name: guess.carrier?.name ?? sh.carrier ?? null, known: guess.known };
    if (guess.carrier && !sh.carrier) clean.shipment = { ...sh, carrier: guess.carrier.name };
    return NextResponse.json({ result: clean });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error leyendo el documento" }, { status: 502 });
  }
}
