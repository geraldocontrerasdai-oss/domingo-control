// Unifica nombres de proveedor: "Zulfiqar Motors" y "Zulfiqar Motors Co., Ltd" son el mismo; todo lo de Cox/Manheim es "Manheim".
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const GENERIC = new Set(["motor", "motors", "auto", "autos", "co", "ltd", "corp", "corporation", "company", "llc", "inc", "the", "trading", "export", "import"]);

export function canonicalSupplier(raw: string | null | undefined, existing: string[]): string | null {
  const name = (raw ?? "").trim();
  if (!name) return null;
  if (/manheim|cox\s*automotive/i.test(name)) return existing.find((e) => norm(e) === "manheim") ?? "Manheim";
  const exact = existing.find((e) => norm(e) === norm(name));
  if (exact) return exact;
  // Misma primera palabra distintiva (≥4 letras): "Kobe Motor Company" ~ "KOBE MOTORS"
  const first = (n: string) => n.toLowerCase().split(/[^a-z0-9]+/).find((w) => w.length >= 4 && !GENERIC.has(w)) ?? "";
  const f = first(name);
  if (f) { const hit = existing.find((e) => first(e) === f); if (hit) return hit; }
  return name;
}
