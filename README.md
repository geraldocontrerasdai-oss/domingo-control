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

## Fotos y videos de cada vehículo
- La **foto principal** es la que se ve en el mapa y en las tarjetas del vehículo. La primera foto que se sube pasa a ser la principal; después se puede cambiar con "Hacer foto principal".
- Al seleccionar un vehículo se abre su **galería** con todas las fotos y videos que haya subido el equipo.
- Solo `admin` y `operaciones` pueden subir, cambiar la principal o quitar archivos. `consulta` solo puede verlos.
- Los archivos viven en un bucket **privado** de Supabase (`vehicle-media`); se muestran con enlaces temporales de 1 hora.
- Las fotos se reducen automáticamente antes de subir. Los videos pueden pesar hasta 50 MB (tope del plan gratuito de Supabase).
- Quitar un archivo lo archiva; no se borra.

## Datos reales
Los datos de operación (VIN, BL, bookings) **no se guardan en este repositorio**. Se cargan directamente en Supabase.
