-- Migración 0002: fotos y videos por vehículo, y posición de buques en el mapa.
-- Sigue sin existir ningún dato financiero.

-- ───────────── Posición en la ruta (sin AIS) ─────────────
-- 0 = punto de origen, 1 = destino. La fija el último evento de la naviera.
alter table tracking_events
  add column route_progress numeric(4, 3) check (route_progress between 0 and 1);

create or replace view v_voyage_last_event as
select distinct on (voyage_id) voyage_id, event_type, location, occurred_at, observed_at, source, route_progress
from tracking_events
where voyage_id is not null
order by voyage_id, observed_at desc;

-- ───────────── Fotos y videos del vehículo ─────────────
create type media_kind as enum ('photo', 'video');

create table vehicle_media (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles (id),
  kind media_kind not null,
  storage_path text not null unique,
  content_type text,
  size_bytes bigint,
  caption text,
  is_primary boolean not null default false,
  uploaded_by uuid references profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  -- Solo una foto puede ser la principal; un video nunca lo es
  check (not is_primary or kind = 'photo')
);
create index vehicle_media_vehicle_idx on vehicle_media (vehicle_id, created_at);
create unique index vehicle_media_one_primary on vehicle_media (vehicle_id)
  where is_primary and archived_at is null;

alter table vehicle_media enable row level security;
create policy vehicle_media_read on vehicle_media for select to authenticated using (true);
create policy vehicle_media_ins on vehicle_media for insert to authenticated with check (is_staff());
create policy vehicle_media_upd on vehicle_media for update to authenticated using (is_staff()) with check (is_staff());
revoke delete on vehicle_media from anon, authenticated;

create trigger audit_vehicle_media after insert or update or delete on vehicle_media
  for each row execute function log_audit();

-- La primera foto subida pasa a ser la principal automáticamente
create function media_auto_primary() returns trigger language plpgsql as $$
begin
  if new.kind = 'photo' and not exists (
    select 1 from vehicle_media
    where vehicle_id = new.vehicle_id and is_primary and archived_at is null
  ) then
    new.is_primary := true;
  end if;
  return new;
end $$;
create trigger vehicle_media_auto_primary before insert on vehicle_media
  for each row execute function media_auto_primary();

-- Cambiar la foto principal de forma atómica
create function set_primary_media(p_media_id uuid) returns void
language plpgsql security invoker set search_path = public as $$
declare v uuid;
begin
  select vehicle_id into v from vehicle_media where id = p_media_id and kind = 'photo' and archived_at is null;
  if v is null then raise exception 'Solo una foto activa puede ser la principal'; end if;
  update vehicle_media set is_primary = false where vehicle_id = v and is_primary;
  update vehicle_media set is_primary = true where id = p_media_id;
end $$;

-- Archivar un archivo; si era la principal, la siguiente foto toma su lugar
create function archive_media(p_media_id uuid) returns void
language plpgsql security invoker set search_path = public as $$
declare v uuid; was_primary boolean;
begin
  select vehicle_id, is_primary into v, was_primary from vehicle_media where id = p_media_id;
  update vehicle_media set archived_at = now(), is_primary = false where id = p_media_id;
  if was_primary then
    update vehicle_media set is_primary = true
    where id = (select id from vehicle_media
                where vehicle_id = v and kind = 'photo' and archived_at is null
                order by created_at limit 1);
  end if;
end $$;

-- ───────────── Almacenamiento privado ─────────────
-- Límite de 50 MB por archivo (tope del plan gratuito de Supabase).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vehicle-media', 'vehicle-media', false, 52428800,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'video/mp4', 'video/quicktime', 'video/webm'])
on conflict (id) do nothing;

create policy vehicle_media_obj_read on storage.objects for select to authenticated
  using (bucket_id = 'vehicle-media');
create policy vehicle_media_obj_ins on storage.objects for insert to authenticated
  with check (bucket_id = 'vehicle-media' and public.is_staff());
-- Sin update ni delete: los archivos no se sobrescriben ni se borran desde la app.
