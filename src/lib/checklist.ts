// Documentos que exige cada origen para poder despachar.
// - Manheim (RORO): el título físico llega por FedEx a Florida; sin título no se embarca.
// - Contenedor (Japón, Filipinas, Vietnam…): los originales se envían 1–2 semanas después de zarpar
//   a Domingo Auto y deben llegar ANTES que el contenedor para presentar la carga.
export type OriginKind = "manheim" | "japan" | "other";
export type State = "falta" | "transito" | "ok";
export type CourierInfo = { id?: string; kind: string; carrier: string; tracking_no: string; received: boolean };
export type Item = { key: string; label: string; state: State; detail: string; blocking: string | null };

const courierState = (list: CourierInfo[], kind: string): { state: State; detail: string; c?: CourierInfo } => {
  const rows = list.filter((c) => c.kind === kind);
  const got = rows.find((c) => c.received);
  if (got) return { state: "ok", detail: "Recibido y confirmado", c: got };
  const moving = rows[0];
  if (moving) return { state: "transito", detail: `En tránsito · ${moving.carrier.toUpperCase()} ${moving.tracking_no}`, c: moving };
  return { state: "falta", detail: "Aún no hay guía de courier" };
};

export function buildChecklist(o: { origin: OriginKind; blStatus: string; hasBooking?: boolean; docTypes: Set<string>; couriers: CourierInfo[] }): Item[] {
  if (o.origin === "manheim") {
    // Con la etiqueta de Crowley el vehículo ya fue aceptado para el RORO: el título está en mano y el Gate Pass ya se usó.
    const tagged = o.docTypes.has("crowley_tag");
    const t = tagged ? { state: "ok" as State, detail: "No aplica: ya tiene etiqueta de Crowley" } : courierState(o.couriers, "titulo");
    return [
      { key: "title", label: "Título físico (FedEx a Florida)", state: t.state, detail: t.detail, blocking: "No se puede embarcar en el RORO sin el título." },
      { key: "gate_pass", label: "Gate Pass", state: o.docTypes.has("gate_pass") || tagged ? "ok" : "falta", detail: o.docTypes.has("gate_pass") ? "En la carpeta" : tagged ? "No aplica: ya usado (tiene etiqueta de Crowley)" : "Sin subir", blocking: null },
      { key: "crowley_tag", label: "Foto con código Crowley", state: o.docTypes.has("crowley_tag") ? "ok" : "falta", detail: o.docTypes.has("crowley_tag") ? "En la carpeta" : "Sin subir", blocking: null },
    ];
  }
  const t = courierState(o.couriers, "original_bl");
  // Con el número de booking (o BL) basta: la naviera permite rastrear todo con ese número.
  const blOk = o.blStatus === "final";
  const bl = blOk ? "Definitivo" : o.hasBooking ? "No necesario: ya tiene booking" : o.blStatus === "draft" ? "Solo borrador" : "Sin BL ni booking";
  return [
    { key: "bl", label: "BL / booking", state: blOk || o.hasBooking ? "ok" : "falta", detail: bl, blocking: null },
    { key: "originals", label: "Documentos originales (courier a Domingo Auto)", state: t.state, detail: t.detail, blocking: "Deben llegar antes que el contenedor para presentar la carga." },
  ];
}
