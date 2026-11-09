import { normalizeVin, stripMoney, vinWarnings } from "@/lib/vin";
import { detectCarrier } from "@/lib/carriers";
import { canonicalSupplier } from "@/lib/suppliers";
import { adminClient } from "@/lib/telegram";
/* eslint-disable @typescript-eslint/no-explicit-any */

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
            supplier: { type: "string", description: "Empresa que vende/exporta el vehículo y emite la factura (ej. Alphinity Corporation, Zulfiqar Motors, Kobe Motor Company, Vigo4u). En facturas de Manheim / Cox Automotive el proveedor es \"Manheim\" (NO el dealer que figura como OWNER). Sin datos bancarios." },
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
- Una captura o guía de DHL/FedEx es courier_receipt: courier.carrier (dhl o fedex), courier.tracking_no (el número de guía o waybill, solo dígitos) y courier.kind "otro" si no sabes. No inventes vehículos: deja vehicles vacío.
- Una foto de un vehículo (exterior, interior, ruedas, motor, tablero) es vehicle_photo con vehicles vacío. Si la foto es de una captura de pantalla o un papel, NO es vehicle_photo.
- Si un dato no aparece, omítelo. No inventes.`;

async function ask(model: string, mediaType: string, b64: string) {
  const block = mediaType === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: mediaType, data: b64 } }
    : { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } };
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model, max_tokens: 4096, tools: [TOOL], tool_choice: { type: "auto" },
      messages: [{ role: "user", content: [block, { type: "text", text: PROMPT + "\n\nResponde SIEMPRE llamando a la herramienta report_document." }] }],
    }),
  });
  if (!r.ok) throw new Error(`IA ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const use = (j.content ?? []).find((c: { type: string }) => c.type === "tool_use");
  if (!use) throw new Error("La IA no devolvió datos");
  return use.input as Record<string, unknown>;
}


// Lee un documento (PDF o imagen) y devuelve los datos limpios, sin dinero y con avisos de VIN.
export async function analyzeDocument(buf: Buffer, mediaType: string): Promise<any> {
  const b64 = buf.toString("base64");
  // Modelo económico primero; si no encuentra ningún chasis, reintenta con el más capaz
  let out = await ask("claude-haiku-5-5", mediaType, b64);
  // Solo se reintenta con el modelo grande cuando parecía un documento con chasis y no se encontró ninguno
  const noVin = !Array.isArray(out.vehicles) || out.vehicles.length === 0;
  const expectsNone = out.doc_type === "vehicle_photo" || out.doc_type === "other" || (out.doc_type === "courier_receipt" && (out.courier as any)?.tracking_no);
  if (noVin && !expectsNone) out = await ask("claude-sonnet-5-5", mediaType, b64);
  const clean: any = stripMoney(out);
  let known: string[] = [];
  try { const { data } = await adminClient().from("suppliers").select("name"); known = (data ?? []).map((x: any) => x.name); } catch {}
  clean.vehicles = (clean.vehicles ?? []).map((v: any) => {
    const vin = normalizeVin(String(v.vin ?? ""));
    const supplier = canonicalSupplier(v.supplier, known) ?? undefined;
    return { ...v, supplier, vin, warnings: vinWarnings(vin) };
  });
  if (clean.shipment?.containers) {
    clean.shipment.containers = clean.shipment.containers.map((c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, ""));
  }
  const sh = clean.shipment ?? {};
  const guess = detectCarrier(sh.carrier, sh.bl_no, sh.booking_no);
  clean.carrier_info = { name: guess.carrier?.name ?? sh.carrier ?? null, known: guess.known };
  if (guess.carrier && !sh.carrier) clean.shipment = { ...sh, carrier: guess.carrier.name };
  return clean;
}
