// Eventos que entiende la plataforma. Cada uno fija una posición por defecto en la ruta
// (0 a 1) y la etapa que toman los vehículos. Los usan la actualización a mano y el agente.
export const TRACK_EVENTS: { code: string; label: string; progress: number; stage: string; roro: boolean }[] = [
  { code: "booked", label: "Con reserva", progress: 0, stage: "con_reserva", roro: true },
  { code: "loading_origin", label: "Cargando en origen", progress: 0, stage: "con_reserva", roro: true },
  { code: "departed", label: "Zarpó de origen", progress: 0.08, stage: "embarcado", roro: true },
  { code: "in_transit", label: "En tránsito (en altamar)", progress: 0.5, stage: "en_transito", roro: true },
  { code: "panama", label: "Cruzando el Canal de Panamá", progress: 0.904, stage: "en_transito", roro: false },
  { code: "caribbean", label: "Navegando el Caribe", progress: 0.95, stage: "en_transito", roro: false },
  { code: "arrived", label: "Arribó a destino", progress: 1, stage: "arribado", roro: true },
  { code: "discharged", label: "Descargado", progress: 1, stage: "arribado", roro: true },
];
export const EVENT_CODES = TRACK_EVENTS.map((e) => e.code);
export const FINAL_EVENTS = ["arrived", "discharged"];
export const RUN_EVERY_HOURS = 24;
