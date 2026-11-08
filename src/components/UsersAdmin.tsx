"use client";
import { useCallback, useEffect, useState } from "react";

type U = { id: string; email: string; full_name: string | null; role: string; last: string | null; blocked: boolean };
const ROLE: Record<string, string> = { admin: "Administrador", operaciones: "Operaciones", consulta: "Solo lectura" };
const HINT: Record<string, string> = {
  admin: "Todo, incluido crear usuarios.", operaciones: "Sube y edita fotos, documentos y expedientes.", consulta: "Ve todo (mapa, vehículos, alertas, documentos). No puede modificar ni subir nada.",
};

export default function UsersAdmin() {
  const [users, setUsers] = useState<U[]>([]);
  const [me, setMe] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("consulta");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const r = await fetch("/api/users"); const j = await r.json();
    if (!r.ok) { setMsg(j.error ?? "Error"); return; }
    setUsers(j.users); setMe(j.me);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function call(method: string, body: object, ok: string) {
    setMsg("");
    const r = await fetch("/api/users", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    setMsg(r.ok ? ok : j.error ?? `Error ${r.status}`);
    if (r.ok) { setEmail(""); setName(""); load(); }
  }

  return (
    <div className="max-w-4xl mx-auto p-6 text-white">
      <h1 className="text-xs tracking-[0.3em] text-white/60">USUARIOS Y ROLES</h1>
      <div className="mt-4 border border-white/15 p-4">
        <div className="text-sm mb-3">Dar acceso a una persona</div>
        <div className="grid md:grid-cols-[1fr_1fr_180px_auto] gap-2 text-sm">
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Correo" className="bg-black border border-white/30 px-3 py-2" />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre (opcional)" className="bg-black border border-white/30 px-3 py-2" />
          <select value={role} onChange={(e) => setRole(e.target.value)} className="bg-black border border-white/30 px-3 py-2">
            {Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button onClick={() => call("POST", { email, full_name: name, role }, `Listo. ${email} ya puede entrar con su correo.`)} className="border border-white px-4 py-2 hover:bg-white hover:text-black">Dar acceso</button>
        </div>
        <p className="text-xs text-white/45 mt-2">{HINT[role]} La persona entra en la página de inicio con su correo y recibe un enlace.</p>
      </div>
      {msg && <p className="mt-3 text-sm text-white/80">{msg}</p>}

      <div className="mt-4 border border-white/10">
        {users.map((u) => (
          <div key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-white/5 last:border-0 text-sm">
            <div className="min-w-0 flex-1">
              <div>{u.full_name || u.email}{u.id === me && <span className="text-white/40"> (tú)</span>}{u.blocked && <span className="ml-2 text-red-300 text-xs">ACCESO QUITADO</span>}</div>
              <div className="text-xs text-white/45">{u.full_name ? u.email + " · " : ""}{u.last ? "Último ingreso " + new Date(u.last).toLocaleDateString("es-DO", { day: "numeric", month: "short", timeZone: "America/Santo_Domingo" }) : "Aún no ha entrado"}</div>
            </div>
            <select disabled={u.id === me} value={u.role} onChange={(e) => call("PATCH", { id: u.id, role: e.target.value }, "Rol actualizado.")} className="bg-black border border-white/30 px-2 py-1 disabled:opacity-40">
              {Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            {u.id !== me && (
              <button onClick={() => { if (u.blocked || confirm(`¿Quitar el acceso a ${u.email}? Podrás devolvérselo cuando quieras.`)) call("PATCH", { id: u.id, blocked: !u.blocked }, u.blocked ? "Acceso devuelto." : "Acceso quitado."); }}
                className="border border-white/25 px-2 py-1 text-white/70 hover:border-white">{u.blocked ? "Devolver acceso" : "Quitar acceso"}</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
