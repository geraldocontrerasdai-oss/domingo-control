-- Migración 0003: la ETA vigente es la observación más reciente.
-- (Antes se priorizaba por fuente y una carga inicial impedía ver las actualizaciones manuales.)
create or replace view v_current_eta as
select distinct on (coalesce(voyage_id, shipment_id)) coalesce(voyage_id, shipment_id) as ref_id,
  voyage_id, shipment_id, eta, source, observed_at
from eta_observations
order by coalesce(voyage_id, shipment_id), observed_at desc;
