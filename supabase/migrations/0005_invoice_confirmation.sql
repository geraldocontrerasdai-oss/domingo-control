-- Migración 0005: la FACTURA es la fuente madre de cada vehículo.
-- Un vehículo creado desde otro documento (BL, etiqueta Crowley, título…) queda "sin confirmar"
-- hasta que se lea su factura. La factura en sí no se guarda: solo queda esta marca de fecha.
alter table vehicles add column if not exists invoice_confirmed_at timestamptz;
