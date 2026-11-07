"use client";
import { useState } from "react";
import { createClient } from "@/lib/supabase/browser";

export default function Login() {
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");
  async function send(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await createClient().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${location.origin}/auth/callback`, shouldCreateUser: false },
    });
    setMsg(error ? "No se pudo enviar el enlace." : "Revisa tu correo: te enviamos un enlace de acceso.");
  }
  return (
    <main className="min-h-screen grid place-items-center">
      <form onSubmit={send} className="w-80 space-y-4">
        <h1 className="text-xs tracking-[0.3em] text-white/60">DOMINGO CONTROL</h1>
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="correo"
          className="w-full bg-transparent border border-white/20 px-3 py-2 outline-none focus:border-white" />
        <button className="w-full border border-white px-3 py-2 hover:bg-white hover:text-black">Entrar</button>
        {msg && <p className="text-sm text-white/60">{msg}</p>}
      </form>
    </main>
  );
}
