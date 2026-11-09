// Regla fija: al llegar al 80 % de lo que incluye un servicio gratuito, se empieza a evaluar pasar a plan de pago.
export const PLAN_ALERT_PCT = 0.8;
// Supabase (plan gratuito): 1 GB de archivos. La base de datos (500 MB), el tráfico y Vercel
// no se pueden medir desde aquí: se revisan en sus paneles de uso.
export const SUPABASE_STORAGE_FREE_BYTES = 1024 ** 3;
