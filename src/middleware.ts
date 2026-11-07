import { createServerClient } from "@supabase/ssr";
import type { CookieOptions } from "@supabase/ssr";
type CookieToSet = { name: string; value: string; options: CookieOptions };
import { NextResponse, type NextRequest } from "next/server";

// Toda la plataforma es privada: sin sesión → /login.
export async function middleware(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const open = req.nextUrl.pathname.startsWith("/login") || req.nextUrl.pathname.startsWith("/auth");
  if (!url || !key) {
    return new NextResponse("Falta configurar NEXT_PUBLIC_SUPABASE_URL o NEXT_PUBLIC_SUPABASE_ANON_KEY en Vercel.", { status: 500 });
  }
  try {
    return await run(req, url, key, open);
  } catch {
    return open ? NextResponse.next() : NextResponse.redirect(new URL("/login", req.url));
  }
}

async function run(req: NextRequest, url: string, key: string, open: boolean) {
  let res = NextResponse.next({ request: req });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list: CookieToSet[]) => {
        list.forEach(({ name, value }) => req.cookies.set(name, value));
        res = NextResponse.next({ request: req });
        list.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      },
    },
  });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user && !open) return NextResponse.redirect(new URL("/login", req.url));
  return res;
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
