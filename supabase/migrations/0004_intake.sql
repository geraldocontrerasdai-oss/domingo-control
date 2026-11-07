-- Migración 0004: bandeja de documentos.
-- Las FACTURAS NO SE GUARDAN: la app las lee y las descarta. Aquí solo se guardan
-- documentos sin montos (BL, Gate Pass, título, etiqueta Crowley, guía de courier).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 20971520,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do nothing;

create policy documents_obj_read on storage.objects for select to authenticated
  using (bucket_id = 'documents');
create policy documents_obj_ins on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and public.is_staff());

-- Crea o actualiza embarque, contenedores, vehículos, documentos y courier a partir
-- de lo que el usuario revisó y confirmó en la bandeja. Corre con los permisos del
-- usuario (RLS): solo admin y operaciones pueden ejecutarla con efecto.
--
-- p_items: [{
--   doc_type: 'bl'|'gate_pass'|'crowley_tag'|'title'|'courier_receipt'|'invoice'|'other',
--   storage_path, sha256, file_name,           -- vacíos en facturas (no se guardan)
--   origin: 'manheim'|'japan'|'other',
--   shipment: {booking_no, bl_no, bl_status, mode, carrier, vessel, voyage, port_loading,
--              port_discharge, consignee, containers: [..]},
--   vehicles: [{vin, year, make, model, color, origin_place, container_no, supplier}],
--   courier: {carrier, tracking_no, kind}
-- }]
create function intake_commit(p_items jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  it jsonb; v jsonb; c text;
  ship jsonb; _ship uuid; _vessel uuid; _voyage uuid; booking text; blno text;
  _veh uuid; _cont uuid; ident text; _kind id_kind; org origin_kind;
  doc_code text; _vehs uuid[]; n_veh_new int := 0; n_veh_upd int := 0; n_docs int := 0;
  n_ship int := 0; sup_id uuid; _courier uuid; new_bl bl_status;
  _single uuid; _conts uuid[];
begin
  if not is_staff() then raise exception 'Sin permiso para crear expedientes'; end if;

  for it in select * from jsonb_array_elements(p_items) loop
    ship := coalesce(it -> 'shipment', '{}'::jsonb);
    _ship := null; _voyage := null; _conts := '{}'; _vehs := '{}'; _single := null;
    org := coalesce(nullif(it ->> 'origin', ''), 'other')::origin_kind;
    booking := nullif(trim(ship ->> 'booking_no'), '');
    blno := nullif(trim(ship ->> 'bl_no'), '');

    -- Embarque
    if booking is not null or blno is not null then
      if nullif(trim(ship ->> 'vessel'), '') is not null then
        select id into _vessel from vessels where lower(name) = lower(trim(ship ->> 'vessel'));
        if _vessel is null then
          insert into vessels(name) values (trim(ship ->> 'vessel')) returning id into _vessel;
        end if;
        select id into _voyage from voyages
          where voyages.vessel_id = _vessel and voyage_no = coalesce(nullif(trim(ship ->> 'voyage'), ''), 'POR CONFIRMAR') limit 1;
        if _voyage is null then
          insert into voyages(vessel_id, voyage_no, carrier, port_loading, port_discharge)
          values (_vessel, coalesce(nullif(trim(ship ->> 'voyage'), ''), 'POR CONFIRMAR'),
                  coalesce(nullif(trim(ship ->> 'carrier'), ''), 'Por confirmar'),
                  ship ->> 'port_loading', ship ->> 'port_discharge') returning id into _voyage;
        end if;
      end if;

      select id into _ship from shipments
        where (booking is not null and booking_no = booking) or (blno is not null and bl_no = blno) limit 1;
      new_bl := coalesce(nullif(ship ->> 'bl_status', ''), case when blno is null then 'none' else 'draft' end)::bl_status;

      if _ship is null then
        insert into shipments(mode, voyage_id, booking_no, bl_no, bl_status, consignee, port_loading, port_discharge)
        values (coalesce(nullif(ship ->> 'mode', ''), 'container')::ship_mode, _voyage,
                coalesce(booking, 'BL ' || blno), blno, new_bl,
                coalesce(nullif(trim(ship ->> 'consignee'), ''), 'Domingo Auto Import SRL'),
                ship ->> 'port_loading', ship ->> 'port_discharge')
        returning id into _ship;
        n_ship := n_ship + 1;
      else
        update shipments set
          voyage_id = coalesce(_voyage, shipments.voyage_id),
          bl_no = coalesce(blno, shipments.bl_no),
          -- un BL definitivo nunca vuelve a borrador
          bl_status = case when shipments.bl_status = 'final' then 'final' else greatest(new_bl, shipments.bl_status) end,
          consignee = coalesce(nullif(trim(ship ->> 'consignee'), ''), shipments.consignee),
          port_loading = coalesce(ship ->> 'port_loading', shipments.port_loading),
          port_discharge = coalesce(ship ->> 'port_discharge', shipments.port_discharge)
        where id = _ship;
      end if;

      for c in select upper(regexp_replace(x, '[^A-Za-z0-9]', '', 'g'))
               from jsonb_array_elements_text(coalesce(ship -> 'containers', '[]'::jsonb)) x loop
        if c ~ '^[A-Z]{4}[0-9]{7}$' then
          insert into containers(shipment_id, container_no) values (_ship, c)
          on conflict (container_no) do update set shipment_id = excluded.shipment_id
          returning id into _cont;
          _conts := _conts || _cont;
        end if;
      end loop;
      if array_length(_conts, 1) = 1 then _single := _conts[1]; end if;
    end if;

    -- Vehículos
    for v in select * from jsonb_array_elements(coalesce(it -> 'vehicles', '[]'::jsonb)) loop
      -- La letra O se normaliza a cero (los BL la escriben, las facturas no)
      ident := replace(upper(regexp_replace(coalesce(v ->> 'vin', ''), '[^A-Za-z0-9]', '', 'g')), 'O', '0');
      continue when ident = '';
      _kind := case when length(ident) = 17 and ident !~ '[IOQ]' then 'vin' else 'chassis' end;
      _cont := _single;
      if nullif(v ->> 'container_no', '') is not null then
        select id into _cont from containers
          where container_no = upper(regexp_replace(v ->> 'container_no', '[^A-Za-z0-9]', '', 'g'));
      end if;

      sup_id := null;
      if nullif(trim(v ->> 'supplier'), '') is not null then
        select id into sup_id from suppliers where name_norm = lower(regexp_replace(v ->> 'supplier', '[^a-zA-Z0-9]+', '', 'g'));
        if sup_id is null then
          insert into suppliers(name) values (trim(v ->> 'supplier')) returning id into sup_id;
        end if;
      end if;

      select id into _veh from vehicles where identifier = ident;
      if _veh is null then
        insert into vehicles(identifier, id_kind, make, model, model_year, color, origin, origin_place,
                             supplier_id, shipment_id, container_id, stage)
        values (ident, _kind, nullif(v ->> 'make', ''), nullif(v ->> 'model', ''),
                nullif(v ->> 'year', '')::smallint, nullif(v ->> 'color', ''), org,
                nullif(v ->> 'origin_place', ''), sup_id, _ship, _cont,
                case when _ship is not null then 'con_reserva' else 'compra_confirmada' end::logistic_stage)
        returning id into _veh;
        n_veh_new := n_veh_new + 1;
      else
        -- Solo se completan los campos vacíos; nunca se pisa lo que ya estaba
        update vehicles set
          make = coalesce(make, nullif(v ->> 'make', '')),
          model = coalesce(model, nullif(v ->> 'model', '')),
          model_year = coalesce(model_year, nullif(v ->> 'year', '')::smallint),
          color = coalesce(color, nullif(v ->> 'color', '')),
          origin_place = coalesce(origin_place, nullif(v ->> 'origin_place', '')),
          supplier_id = coalesce(supplier_id, sup_id),
          shipment_id = coalesce(_ship, shipment_id),
          container_id = coalesce(_cont, container_id)
        where id = _veh;
        n_veh_upd := n_veh_upd + 1;
      end if;
      _vehs := _vehs || _veh;
    end loop;

    -- Documento guardado (las facturas llegan sin storage_path y no se guardan)
    if nullif(it ->> 'storage_path', '') is not null and (it ->> 'doc_type') not in ('invoice', 'other') then
      doc_code := case it ->> 'doc_type'
        when 'bl' then case when coalesce(ship ->> 'bl_status', 'draft') = 'final' then 'bl_final' else 'bl_draft' end
        else it ->> 'doc_type' end;
      -- Solo una versión vigente por tipo; las anteriores quedan guardadas
      update documents set is_current = false
      where doc_type = any(case when doc_code in ('bl_draft', 'bl_final') then array['bl_draft', 'bl_final'] else array[doc_code] end) and is_current
        and ((_ship is not null and shipment_id = _ship)
          or (array_length(_vehs, 1) = 1 and vehicle_id = _vehs[1]));
      insert into documents(vehicle_id, shipment_id, doc_type, storage_path, sha256, version)
      values (case when array_length(_vehs, 1) = 1 and doc_code not in ('bl_draft', 'bl_final') then _vehs[1] end,
              _ship, doc_code, it ->> 'storage_path', it ->> 'sha256',
              1 + (select count(*) from documents d where d.doc_type = any(case when doc_code in ('bl_draft', 'bl_final') then array['bl_draft', 'bl_final'] else array[doc_code] end)
                   and ((_ship is not null and d.shipment_id = _ship)
                     or (array_length(_vehs, 1) = 1 and d.vehicle_id = _vehs[1]))));
      n_docs := n_docs + 1;
    end if;

    -- Courier (FedEx/DHL) con su guía
    if nullif(trim(it #>> '{courier,tracking_no}'), '') is not null then
      insert into courier_shipments(carrier, tracking_no, kind)
      values (coalesce(nullif(it #>> '{courier,carrier}', ''), 'other')::courier,
              trim(it #>> '{courier,tracking_no}'),
              coalesce(nullif(it #>> '{courier,kind}', ''), 'titulo')::courier_kind)
      on conflict (carrier, tracking_no) do update set kind = excluded.kind
      returning id into _courier;
      insert into courier_vehicles(courier_id, vehicle_id) select _courier, unnest(_vehs) on conflict do nothing;
    end if;
  end loop;

  return jsonb_build_object('vehicles_new', n_veh_new, 'vehicles_updated', n_veh_upd,
                            'shipments_new', n_ship, 'documents', n_docs);
end $$;
