"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";

// Barra superior compartida. Consulta no ve la Bandeja (no puede subir nada).
export default function AppNav({ role, info }: { role: string; info?: string }) {
  const path = usePathname();
  const router = useRouter();
  const links = [["/mapa", "Mapa"], ["/vehiculos", "Vehículos"], ...(role !== "consulta" ? [["/bandeja", "Bandeja"]] : [])];
  return (
    <header className="h-12 shrink-0 flex items-center justify-between px-5 border-b border-white/10 bg-black text-white">
      <div className="flex items-baseline gap-6">
        <span className="text-xs tracking-[0.3em]">DOMINGO CONTROL</span>
        <nav className="flex gap-4 text-sm">
          {links.map(([href, label]) => (
            <Link key={href} href={href} className={path.startsWith(href) ? "text-white" : "text-white/45 hover:text-white"}>{label}</Link>
          ))}
        </nav>
        {info && <span className="text-xs text-white/40">{info}</span>}
      </div>
      <div className="flex items-center gap-4 text-xs">
        <span className="border border-white/20 px-2 py-0.5 tracking-widest text-white/60">{role === "consulta" ? "SOLO LECTURA" : role.toUpperCase()}</span>
        <button onClick={async () => { await createClient().auth.signOut(); router.push("/login"); }} className="text-white/50 hover:text-white">Salir</button>
      </div>
    </header>
  );
}
