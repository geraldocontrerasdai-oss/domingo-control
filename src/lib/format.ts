export const STAGES: Record<string, string> = {
  compra_confirmada: "Compra confirmada", recogido_origen: "Recogido en origen", con_reserva: "Con reserva",
  embarcado: "Embarcado", en_transito: "En tránsito", arribado: "Arribado",
};
export const DOCS: Record<string, string> = {
  completo: "Documentos completos", pendiente_no_critico: "Pendiente (no crítico)",
  pendiente_critico: "Pendiente crítico", con_rechazo: "Con rechazo",
};
export const BL_STATUS: Record<string, string> = { none: "Sin BL", draft: "BL borrador", final: "BL definitivo" };

export function ago(iso: string | null): string {
  if (!iso) return "sin datos";
  const h = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 36e5));
  if (h < 1) return "hace menos de 1 h";
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return `hace ${d} ${d === 1 ? "día" : "días"}`;
}

export function shortDate(iso: string | null): string {
  if (!iso) return "Sin ETA";
  // Las fechas sin hora (AAAA-MM-DD) se muestran tal cual; con hora, en la zona de Santo Domingo
  return new Date(iso).toLocaleDateString("es-DO", { day: "numeric", month: "short", timeZone: iso.length === 10 ? "UTC" : "America/Santo_Domingo" });
}
