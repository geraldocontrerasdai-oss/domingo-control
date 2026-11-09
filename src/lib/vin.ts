// Validación de chasis/VIN. La IA solo lee: estas reglas las aplica el código.
const MAP: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

// Los BL escriben la letra O donde la factura tiene cero: se normaliza a cero.
export const normalizeVin = (s: string) => {
  const v = s.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/O/g, "0");
  // Un VIN de 17 caracteres nunca lleva I ni Q (se leen como 1 y 0)
  return v.length === 17 ? v.replace(/Q/g, "0").replace(/I/g, "1") : v;
};

export function checkDigitOk(vin: string): boolean {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i];
    const v = /\d/.test(ch) ? Number(ch) : MAP[ch];
    if (v === undefined) return false;
    sum += v * WEIGHTS[i];
  }
  const r = sum % 11;
  return vin[8] === (r === 10 ? "X" : String(r));
}

/** Avisos para el revisor. Nunca bloquean: un VIN de Japón o Europa no cumple el dígito verificador. */
export function vinWarnings(vin: string): string[] {
  const w: string[] = [];
  if (vin.length !== 17) w.push(`Tiene ${vin.length} caracteres (un VIN tiene 17): verifícalo contra el documento`);
  else {
    if (/[IQ]/.test(vin)) w.push("Contiene I o Q, que no existen en un VIN");
    // El dígito verificador solo es obligatorio en vehículos de Norteamérica (VIN que empieza en 1–5)
    if (/^[1-5]/.test(vin) && !checkDigitOk(vin)) w.push("El dígito verificador no coincide: posible error de lectura");
  }
  return w;
}

const MONEY = /(price|precio|total|amount|monto|payment|pago|bank|banco|account|cuenta|iban|swift|cost|costo|fob|cif|tax|fee|balance|invoice_value|valor)/i;
/** Elimina cualquier campo de dinero que la IA devuelva por error. */
export function stripMoney<T>(x: T): T {
  if (Array.isArray(x)) return x.map(stripMoney) as unknown as T;
  if (x && typeof x === "object") {
    return Object.fromEntries(
      Object.entries(x as Record<string, unknown>).filter(([k]) => !MONEY.test(k)).map(([k, v]) => [k, stripMoney(v)]),
    ) as T;
  }
  return x;
}
