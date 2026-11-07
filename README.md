# Domingo Control

Sistema de Control de Importaciones de Domingo Auto Import SRL.

Stack: Next.js + TypeScript, Supabase (Postgres, Auth, Storage, RLS), Vercel, Claude API.

## Regla de privacidad
Este proyecto **no guarda información financiera**: ni precios, totales, pagos, costos ni datos bancarios.
Las facturas solo se usan para crear el vehículo. La tabla `ai_extractions` rechaza por constraint
cualquier campo con nombres financieros. No subir facturas ni documentos al repositorio (`*.pdf` está ignorado).

## Roles
- `admin`: todo, incluida gestión de usuarios y configuración.
- `operaciones`: crea y edita expedientes.
- `consulta`: solo lectura (entra al mapa y ve todo, no cambia nada).

## Fases
- Fase 1: maqueta visual + esquema de base de datos (`supabase/migrations/0001_init.sql`).
