// Registro de navieras. Cualquier naviera funciona para leer un BL; esta lista solo sirve
// para reconocerla y ofrecer el enlace a su página pública de seguimiento.
// Los 4 primeros caracteres de un BL/booking suelen ser el código SCAC de la naviera.
export type Carrier = { code: string; name: string; prefixes: string[]; names: RegExp; url: string };

export const CARRIERS: Carrier[] = [
  { code: "MSC", name: "MSC", prefixes: ["MEDU", "MSCU", "EBKG"], names: /\bmsc\b|mediterranean shipping/i, url: "https://www.msc.com/en/track-a-shipment" },
  { code: "ONE", name: "ONE (Ocean Network Express)", prefixes: ["ONEY"], names: /\bone\b|ocean network express/i, url: "https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking" },
  { code: "EGLV", name: "Evergreen", prefixes: ["EGLV", "EGHU", "EISU"], names: /evergreen/i, url: "https://ct.shipmentlink.com/servlet/TDB1_CargoTracking.do" },
  { code: "HLCU", name: "Hapag-Lloyd", prefixes: ["HLCU", "HLCL", "HLXU"], names: /hapag/i, url: "https://www.hapag-lloyd.com/en/online-business/track/track-by-booking-solution.html" },
  { code: "MAEU", name: "Maersk", prefixes: ["MAEU", "MSKU", "MRKU"], names: /maersk/i, url: "https://www.maersk.com/tracking/" },
  { code: "CMDU", name: "CMA CGM", prefixes: ["CMDU", "CMAU"], names: /cma[\s-]?cgm/i, url: "https://www.cma-cgm.com/ebusiness/tracking/search" },
  { code: "COSU", name: "COSCO", prefixes: ["COSU", "CBHU"], names: /cosco/i, url: "https://elines.coscoshipping.com/ebusiness/cargoTracking" },
  { code: "OOLU", name: "OOCL", prefixes: ["OOLU", "OOCU"], names: /oocl|orient overseas/i, url: "https://www.oocl.com/eng/ourservices/eservices/cargotracking/Pages/default.aspx" },
  { code: "ZIMU", name: "ZIM", prefixes: ["ZIMU"], names: /\bzim\b/i, url: "https://www.zim.com/tools/track-a-shipment" },
  { code: "YMLU", name: "Yang Ming", prefixes: ["YMLU"], names: /yang\s?ming/i, url: "https://www.yangming.com/e-service/Track_Trace/track_trace_cargo_tracking.aspx" },
  { code: "HDMU", name: "HMM", prefixes: ["HDMU"], names: /\bhmm\b|hyundai merchant/i, url: "https://www.hmm21.com/e-service/general/trackNTrace/TrackNTrace.do" },
  { code: "CROWLEY", name: "Crowley", prefixes: ["CAT"], names: /crowley/i, url: "https://csight.crowley.com/crowley/s/shipment-tracking" },
];

export type CarrierGuess = { carrier: Carrier | null; known: boolean };

/** Reconoce la naviera por el nombre que trae el documento o, si falta, por el prefijo del BL/booking. */
export function detectCarrier(name?: string | null, ...numbers: (string | null | undefined)[]): CarrierGuess {
  if (name) {
    const byName = CARRIERS.find((c) => c.names.test(name));
    if (byName) return { carrier: byName, known: true };
  }
  for (const n of numbers) {
    const p = (n ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
    const hit = p && CARRIERS.find((c) => c.prefixes.some((x) => p.startsWith(x)));
    if (hit) return { carrier: hit, known: true };
  }
  return { carrier: null, known: false };
}

/** Número tal como lo acepta el buscador de la naviera. ONE pide los últimos 12 caracteres, SIN el prefijo "ONEY":
 *  con el prefijo responde "No Data Found". */
export function searchNumber(carrier: Carrier | null, number: string): string {
  const n = number.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return carrier?.code === "ONE" ? n.replace(/^ONEY/, "") : n;
}

/** Enlace a la página pública de seguimiento. Maersk y ONE aceptan el número en la dirección
 *  (ONE: ?trakNoParam=), lo que evita escribir en el buscador y que los avisos emergentes estorben. */
export function trackUrl(carrier: Carrier | null, number?: string | null): string | null {
  if (!carrier) return null;
  if (carrier.code === "MAEU" && number) return carrier.url + encodeURIComponent(number);
  if (carrier.code === "ONE" && number) return `${carrier.url}?trakNoParam=${encodeURIComponent(searchNumber(carrier, number))}`;
  return carrier.url;
}
