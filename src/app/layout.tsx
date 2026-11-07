import "./globals.css";
export const metadata = { title: "Domingo Control", description: "Control de importaciones" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="es"><body className="min-h-screen">{children}</body></html>);
}
