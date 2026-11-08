import { geoNaturalEarth1 } from "d3-geo";

// Geometría del mapa. Se calcula en el servidor; al navegador solo llegan trazos SVG.
export const W = 1000;
export const H = 520;

const proj = geoNaturalEarth1().rotate([100, 0]).fitExtent([[6, 6], [W - 6, H - 6]], { type: "Sphere" });
type Pt = [number, number];
const P = (ll: Pt): Pt => proj(ll) as Pt;

// Los puertos se reconocen por palabra clave en el texto del embarque.
const PORTS: { key: RegExp; ll: Pt }[] = [
  { key: /yokohama|jap[oó]n|japan|tokyo|saitama/i, ll: [139.65, 35.45] },
  { key: /manila|filipinas|philippines/i, ll: [120.97, 14.58] },
  { key: /ho chi minh|c[aá]t l[aá]i|vietnam|viet nam/i, ll: [106.79, 10.76] },
  { key: /manheim|estados unidos|\busa\b/i, ll: [-97, 33.5] },
  { key: /everglades|uspef/i, ll: [-80.12, 26.09] },
  { key: /haina|dohai|caucedo|docau|santo domingo|dominican|dominicana/i, ll: [-69.9, 18.43] },
];
const BAL = P([-79.55, 8.95]); // Balboa (Pacífico)
const CRI = P([-79.9, 9.35]); // Cristóbal (Caribe)

export const portPoint = (text: string | null | undefined): Pt | null => {
  if (!text) return null;
  const hit = PORTS.find((p) => p.key.test(text));
  return hit ? P(hit.ll) : null;
};

const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const f = (n: number) => +n.toFixed(1);

type Piece = { t: "q" | "l"; p0: Pt; c: Pt | null; p1: Pt };
const lpiece = (p0: Pt, p1: Pt): Piece => ({ t: "l", p0, c: null, p1 });

// Tramo curvo: se separa de la cuerda como máximo `d` unidades hacia el lado `side`.
function qpiece(p0: Pt, p1: Pt, d: number, side: 1 | -1): Piece {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], L = Math.hypot(dx, dy) || 1;
  const n: Pt = [(-dy / L) * side, (dx / L) * side];
  const m = lerp(p0, p1, 0.5);
  return { t: "q", p0, c: [m[0] + n[0] * 2 * d, m[1] + n[1] * 2 * d], p1 };
}

const ptAt = (pc: Piece, t: number): Pt => {
  if (pc.t === "l") return lerp(pc.p0, pc.p1, t);
  return lerp(lerp(pc.p0, pc.c!, t), lerp(pc.c!, pc.p1, t), t);
};

function split(pc: Piece, t: number): [Piece, Piece] {
  if (pc.t === "l") {
    const m = lerp(pc.p0, pc.p1, t);
    return [lpiece(pc.p0, m), lpiece(m, pc.p1)];
  }
  const a = lerp(pc.p0, pc.c!, t), b = lerp(pc.c!, pc.p1, t), m = lerp(a, b, t);
  return [{ t: "q", p0: pc.p0, c: a, p1: m }, { t: "q", p0: m, c: b, p1: pc.p1 }];
}

const seg = (pc: Piece) =>
  pc.t === "l" ? `L${f(pc.p1[0])},${f(pc.p1[1])}` : `Q${f(pc.c![0])},${f(pc.c![1])} ${f(pc.p1[0])},${f(pc.p1[1])}`;
const toPath = (pcs: Piece[]) => (pcs.length ? `M${f(pcs[0].p0[0])},${f(pcs[0].p0[1])}` + pcs.map(seg).join("") : "");
const pct = (p: Pt) => ({ x: +((p[0] / W) * 100).toFixed(2), y: +((p[1] / H) * 100).toFixed(2) });
const len = (pc: Piece) => Math.hypot(pc.p1[0] - pc.p0[0], pc.p1[1] - pc.p0[1]);

export type RouteGeo = { done: string; todo: string; pos: { x: number; y: number }; tag: { x: number; y: number } };

/**
 * Ruta de un buque. `slot` es el puesto del buque entre los que comparten ruta:
 * cada uno recibe un arco más abierto para que las líneas no se encimen.
 * `progress` (0 a 1) viene del último evento de la naviera.
 */
export function buildRoute(origin: Pt, dest: Pt, viaPanama: boolean, slot: number, progress: number): RouteGeo {
  const pieces: Piece[] = viaPanama
    ? [qpiece(origin, BAL, 14 + 16 * slot, 1), lpiece(BAL, CRI), qpiece(CRI, dest, 4 + 4 * slot, 1)]
    : [qpiece(origin, dest, 9 + 6 * slot, -1)];

  const total = pieces.reduce((s, p) => s + len(p), 0) || 1;
  const target = Math.min(Math.max(progress, 0), 1) * total;
  let acc = 0, idx = pieces.length - 1, t = 1;
  for (let i = 0; i < pieces.length; i++) {
    const l = len(pieces[i]);
    if (target <= acc + l || i === pieces.length - 1) {
      idx = i;
      t = l ? Math.min(Math.max((target - acc) / l, 0), 1) : 0;
      break;
    }
    acc += l;
  }

  const done = pieces.slice(0, idx), todo = pieces.slice(idx + 1);
  let pos: Pt;
  if (t <= 0) { pos = pieces[idx].p0; todo.unshift(pieces[idx]); }
  else if (t >= 1) { pos = pieces[idx].p1; done.push(pieces[idx]); }
  else { const [l, r] = split(pieces[idx], t); done.push(l); todo.unshift(r); pos = l.p1; }

  return { done: toPath(done), todo: toPath(todo), pos: pct(pos), tag: pct(ptAt(pieces[0], viaPanama ? 0.5 : 0.2)) };
}

export const needsPanama = (origin: string | null | undefined) => /yokohama/i.test(origin ?? "");

// Dónde está un vehículo que todavía no tiene embarque: se ubica por su lugar de origen.
const ORIGIN_NAMES: { key: RegExp; name: string }[] = [
  { key: /manheim|estados unidos|\busa\b/i, name: "Estados Unidos (Manheim)" },
  { key: /yokohama|jap[oó]n|japan|tokyo|saitama/i, name: "Japón (Yokohama)" },
  { key: /manila|filipinas|philippines/i, name: "Filipinas (Manila)" },
  { key: /ho chi minh|c[aá]t l[aá]i|vietnam|viet nam/i, name: "Vietnam (Ho Chi Minh)" },
  { key: /everglades|florida|usa|miami/i, name: "Port Everglades (EE. UU.)" },
];
export function originPort(text: string | null | undefined): { name: string; pos: { x: number; y: number } } | null {
  const pt = portPoint(text);
  const nm = ORIGIN_NAMES.find((o) => o.key.test(text ?? ""));
  return pt && nm ? { name: nm.name, pos: pct(pt) } : null;
}

export const PORT_LABELS = [
  { name: "Yokohama", ll: [139.65, 35.45] as Pt },
  { name: "Manila", ll: [120.97, 14.58] as Pt },
  { name: "Ho Chi Minh", ll: [106.79, 10.76] as Pt },
  { name: "Port Everglades", ll: [-80.12, 26.09] as Pt },
  { name: "Panamá", ll: [-79.7, 9.1] as Pt },
  { name: "Río Haina / Caucedo", ll: [-69.9, 18.43] as Pt },
].map((p) => ({ name: p.name, ...pct(P(p.ll)) }));
