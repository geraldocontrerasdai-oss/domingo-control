-- Domingo Auto Import · Sistema de Control de Importaciones
-- Migración 0001: esquema inicial.
--
-- REGLA DE DISEÑO: este sistema NO guarda información financiera.
-- No existen columnas de precios, totales, pagos, cuentas bancarias ni costos.
-- Las facturas se usan solo para crear el vehículo y registrar sus datos.
-- ai_extractions rechaza cualquier campo con esos nombres (ver constraint).

create extension if not exists pgcrypto;

-- ───────────── Tipos ─────────────
create type app_role as enum ('admin', 'operaciones', 'consulta');
create type id_kind as enum ('vin', 'chassis');
create type origin_kind as enum ('manheim', 'japan', 'other');
create type ship_mode as enum ('roro', 'container');
create type bl_status as enum ('none', 'draft', 'final');
create type logistic_stage as enum (
  'compra_confirmada', 'recogido_origen', 'con_reserva',
  'embarcado', 'en_transito', 'arribado'
);
create type doc_status as enum ('completo', 'pendiente_no_critico', 'pendiente_critico', 'con_rechazo');
create type eta_source as enum ('carrier_event', 'carrier_site', 'computed', 'bl_draft', 'manual');
create type courier as enum ('dhl', 'fedex', 'other');
create type courier_kind as enum ('titulo', 'original_bl', 'otro');
create type alert_priority as enum ('critica', 'alta', 'media', 'baja');
create type alert_status as enum ('open', 'resolved', 'dismissed');

-- ───────────── Usuarios y roles ─────────────
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  role app_role not null default 'consulta',
  created_at timestamptz not null default now()
);

create function current_role_app() returns app_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid()
$$;

create function is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(current_role_app() in ('admin', 'operaciones'), false)
$$;

create function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(current_role_app() = 'admin', false)
$$;

-- ───────────── Catálogos ─────────────
create table suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_norm text generated always as (lower(regexp_replace(name, '[^a-zA-Z0-9]+', '', 'g'))) stored,
  country text,
  created_at timestamptz not null default now(),
  unique (name_norm)
);

create table document_types (
  code text primary key,
  label text not null,
  applies_to origin_kind[] -- null = aplica a todos
);

insert into document_types (code, label, applies_to) values
  ('invoice', 'Factura', null),
  ('gate_pass', 'Gate Pass', '{manheim}'),
  ('crowley_tag', 'Etiqueta Crowley', '{manheim}'),
  ('title', 'Título', '{manheim}'),
  ('bl_draft', 'BL borrador', null),
  ('bl_final', 'BL definitivo', null),
  ('courier_receipt', 'Guía de courier', null),
  ('other', 'Otro', null);

-- ───────────── Buques y embarques ─────────────
create table vessels (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  imo text unique check (imo is null or imo ~ '^[0-9]{7}$'),
  created_at timestamptz not null default now()
);

create table voyages (
  id uuid primary key default gen_random_uuid(),
  vessel_id uuid not null references vessels (id),
  voyage_no text not null,
  carrier text not null,
  port_loading text,
  port_discharge text,
  unique (vessel_id, voyage_no)
);

-- Un embarque = un booking. En RORO cada vehículo tiene su booking; en contenedor
-- varios vehículos comparten booking, BL y contenedor.
create table shipments (
  id uuid primary key default gen_random_uuid(),
  mode ship_mode not null,
  voyage_id uuid references voyages (id),
  booking_no text not null unique,
  bl_no text,
  bl_status bl_status not null default 'none',
  consignee text not null default 'Domingo Auto Import SRL',
  port_loading text,
  port_discharge text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table containers (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references shipments (id),
  container_no text not null unique check (container_no ~ '^[A-Z]{4}[0-9]{7}$'),
  seal_no text
);

-- ───────────── Vehículos ─────────────
create table vehicles (
  id uuid primary key default gen_random_uuid(),
  identifier text not null unique check (identifier = upper(identifier) and identifier !~ '[^A-Z0-9]'),
  id_kind id_kind not null,
  -- VIN invertido: permite buscar por los últimos 4/6/8 con un índice de prefijo
  identifier_rev text generated always as (reverse(identifier)) stored,
  make text,
  model text,
  model_year smallint check (model_year between 1980 and 2100),
  color text,
  origin origin_kind not null,
  origin_place text,
  supplier_id uuid references suppliers (id),
  is_provisional boolean not null default false,
  stage logistic_stage not null default 'compra_confirmada',
  docs doc_status not null default 'pendiente_no_critico',
  shipment_id uuid references shipments (id),
  container_id uuid references containers (id),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  -- Un VIN de 17 caracteres nunca contiene I, O ni Q. El chasis japonés puede variar.
  check (id_kind = 'chassis' or (length(identifier) = 17 and identifier !~ '[IOQ]'))
);
create index vehicles_rev_idx on vehicles (identifier_rev text_pattern_ops);
create index vehicles_shipment_idx on vehicles (shipment_id);

-- ───────────── Documentos ─────────────
create table documents (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid references vehicles (id),
  shipment_id uuid references shipments (id),
  doc_type text not null references document_types (code),
  storage_path text not null,
  sha256 text not null unique,
  version int not null default 1,
  is_current boolean not null default true, -- solo la versión vigente se muestra; las anteriores quedan guardadas
  uploaded_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create index documents_vehicle_idx on documents (vehicle_id);

-- Resultado bruto de la IA. NUNCA incluye datos financieros.
create table ai_extractions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents (id),
  field text not null,
  value text,
  confidence numeric(3, 2) check (confidence between 0 and 1),
  source_text text,
  created_at timestamptz not null default now(),
  constraint no_financial_fields check (
    field !~* '(price|precio|total|amount|monto|payment|pago|bank|banco|account|cuenta|iban|swift|cost|costo|fob|cif|tax|fee|balance)'
  )
);

-- ───────────── Seguimiento ─────────────
create table tracking_events (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid references shipments (id),
  voyage_id uuid references voyages (id),
  event_type text not null, -- cargado, zarpó, transbordo, descargado, etc.
  location text,
  occurred_at timestamptz,
  observed_at timestamptz not null default now(),
  source text not null, -- msc_web, crowley_web, manual, ...
  raw jsonb
);
create index tracking_events_voyage_idx on tracking_events (voyage_id, observed_at desc);

create table eta_observations (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid references shipments (id),
  voyage_id uuid references voyages (id),
  eta timestamptz not null,
  source eta_source not null,
  observed_at timestamptz not null default now()
);

-- Último evento por viaje: es la posición del buque en el mapa (sin AIS).
create view v_voyage_last_event as
select distinct on (voyage_id) voyage_id, event_type, location, occurred_at, observed_at, source
from tracking_events
where voyage_id is not null
order by voyage_id, observed_at desc;

-- ETA vigente: la de mayor confianza (orden del enum) y más reciente.
create view v_current_eta as
select distinct on (coalesce(voyage_id, shipment_id)) coalesce(voyage_id, shipment_id) as ref_id,
  voyage_id, shipment_id, eta, source, observed_at
from eta_observations
order by coalesce(voyage_id, shipment_id), source, observed_at desc;

-- ───────────── Courier (títulos y originales) ─────────────
create table courier_shipments (
  id uuid primary key default gen_random_uuid(),
  carrier courier not null,
  tracking_no text not null,
  kind courier_kind not null,
  status text,
  last_checked_at timestamptz,
  received_confirmed_by uuid references profiles (id),
  received_confirmed_at timestamptz,
  unique (carrier, tracking_no),
  -- “entregado” del courier nunca cierra la tarea: la cierra una persona
  check ((received_confirmed_by is null) = (received_confirmed_at is null))
);

create table courier_vehicles (
  courier_id uuid not null references courier_shipments (id),
  vehicle_id uuid not null references vehicles (id),
  primary key (courier_id, vehicle_id)
);

-- ───────────── Alertas ─────────────
create table alerts (
  id uuid primary key default gen_random_uuid(),
  rule_code text not null,
  entity_type text not null,
  entity_id uuid not null,
  priority alert_priority not null,
  status alert_status not null default 'open',
  detail text,
  suggested_action text,
  due_at timestamptz,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
-- Sin duplicados mientras la alerta siga abierta
create unique index alerts_open_unique on alerts (rule_code, entity_type, entity_id) where status = 'open';

create table settings (
  key text primary key,
  value jsonb not null
);
insert into settings (key, value) values
  ('timezone', '"America/Santo_Domingo"'),
  ('tracking_hours', '["08:00", "16:00"]'),
  ('refresh_cooldown_minutes', '30');

-- ───────────── Historial inalterable ─────────────
create table audit_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid default auth.uid(),
  table_name text not null,
  row_id text,
  action text not null,
  before jsonb,
  after jsonb
);

create function log_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_events (table_name, row_id, action, before, after)
  values (
    tg_table_name,
    coalesce((case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ->> 'id', ''),
    tg_op,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return null;
end $$;

create trigger audit_vehicles after insert or update or delete on vehicles for each row execute function log_audit();
create trigger audit_shipments after insert or update or delete on shipments for each row execute function log_audit();
create trigger audit_documents after insert or update or delete on documents for each row execute function log_audit();
create trigger audit_courier after insert or update or delete on courier_shipments for each row execute function log_audit();
create trigger audit_alerts after insert or update or delete on alerts for each row execute function log_audit();

create function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger vehicles_touch before update on vehicles for each row execute function touch_updated_at();
create trigger shipments_touch before update on shipments for each row execute function touch_updated_at();

-- ───────────── Seguridad (RLS) ─────────────
-- Consulta: solo lectura de todo. Operaciones: crea y edita expedientes.
-- Admin: además gestiona usuarios y configuración. Nadie borra físicamente.
alter table profiles enable row level security;
alter table suppliers enable row level security;
alter table document_types enable row level security;
alter table vessels enable row level security;
alter table voyages enable row level security;
alter table shipments enable row level security;
alter table containers enable row level security;
alter table vehicles enable row level security;
alter table documents enable row level security;
alter table ai_extractions enable row level security;
alter table tracking_events enable row level security;
alter table eta_observations enable row level security;
alter table courier_shipments enable row level security;
alter table courier_vehicles enable row level security;
alter table alerts enable row level security;
alter table settings enable row level security;
alter table audit_events enable row level security;

do $$
declare t text;
begin
  foreach t in array array['suppliers','document_types','vessels','voyages','shipments','containers',
    'vehicles','documents','ai_extractions','tracking_events','eta_observations',
    'courier_shipments','courier_vehicles','alerts','settings','audit_events','profiles']
  loop
    execute format('create policy %I on %I for select to authenticated using (true)', t || '_read', t);
  end loop;

  foreach t in array array['suppliers','vessels','voyages','shipments','containers','vehicles','documents',
    'ai_extractions','tracking_events','eta_observations','courier_shipments','courier_vehicles','alerts']
  loop
    execute format('create policy %I on %I for insert to authenticated with check (is_staff())', t || '_ins', t);
    execute format('create policy %I on %I for update to authenticated using (is_staff()) with check (is_staff())', t || '_upd', t);
  end loop;
end $$;

create policy profiles_admin_write on profiles for all to authenticated using (is_admin()) with check (is_admin());
create policy settings_admin_write on settings for all to authenticated using (is_admin()) with check (is_admin());
create policy document_types_admin_write on document_types for all to authenticated using (is_admin()) with check (is_admin());

-- Historial: solo lo escriben los triggers; ningún rol puede actualizar ni borrar
revoke insert, update, delete, truncate on audit_events from anon, authenticated;
-- Sin DELETE en tablas operativas: “eliminar” = archivar (archived_at)
revoke delete on vehicles, shipments, documents, containers, courier_shipments, alerts from anon, authenticated;
