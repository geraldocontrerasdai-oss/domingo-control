-- "Retirado del puerto": un buque descargado se queda en el mapa mientras tenga vehículos sin retirar.
alter table vehicles add column if not exists picked_up_at timestamptz;

-- Los vehículos ya arribados se dan por retirados, excepto los que siguen en el muelle.
update vehicles set picked_up_at = now()
where stage = 'arribado' and archived_at is null and picked_up_at is null
  and identifier not in ('ZFF01SMJ000316231', 'W1N4652501X070229', '2T2BCMEA6PC002243');
