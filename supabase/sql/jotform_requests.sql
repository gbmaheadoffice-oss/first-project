-- Jotform GBMA Leave Form -> hris_docs 'leaves', GBMA Permit to Work -> hris_docs 'permits'.
-- Each row is {id, data, sync, fill, set}:
--   data  the whole record, used only the first time the submission is seen (status 'Pending')
--   sync  the employee's answers; refreshed while HR has not decided yet (status 'Pending'), otherwise only 'jotform'
--   fill  links (employee, leave) that are written only while still empty, so HR's own linking is kept
--   set   always written (attachments copied from Jotform on a later run)
create or replace function public.hris_upsert_jotform(col text, rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare r jsonb; d jsonb; nd jsonb; f jsonb; k text; n integer := 0;
begin
  if col not in ('leaves', 'permits') then raise exception 'unsupported collection %', col; end if;
  for r in select * from jsonb_array_elements(rows) loop
    select data into d from public.hris_docs where collection = col and id = r->>'id' for update;
    if not found then
      insert into public.hris_docs (collection, id, data, updated_at)
      values (col, r->>'id', (r->'data') || jsonb_build_object('id', r->>'id',
        'updatedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), now());
      n := n + 1;
      continue;
    end if;
    nd := d || case when d->>'status' = 'Pending' then coalesce(r->'sync', '{}') else jsonb_build_object('jotform', r->'sync'->'jotform') end;
    f := coalesce(r->'fill', '{}');
    for k in select jsonb_object_keys(f) loop
      if coalesce(d->>k, '') = '' and coalesce(f->>k, '') <> '' then nd := nd || jsonb_build_object(k, f->k); end if;
    end loop;
    nd := nd || coalesce(r->'set', '{}');
    if nd is distinct from d then
      update public.hris_docs set data = nd || jsonb_build_object('updatedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
        updated_at = now() where collection = col and id = r->>'id';
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke all on function public.hris_upsert_jotform(text, jsonb) from public, anon, authenticated;
grant execute on function public.hris_upsert_jotform(text, jsonb) to service_role;

-- Newest Jotform submission time already stored for a collection (jotform-sync fetches only newer ones).
create or replace function public.hris_jotform_last_created(col text)
returns text language sql stable security definer set search_path = public as $$
  select max(data->'jotform'->>'createdAt') from public.hris_docs where collection = col and data->>'source' = 'jotform';
$$;
revoke all on function public.hris_jotform_last_created(text) from public, anon, authenticated;
grant execute on function public.hris_jotform_last_created(text) to service_role;

-- Records jotform-sync needs to match employees, link permits to leaves and keep PTW numbers in series.
create or replace function public.hris_jotform_docs(col text)
returns setof jsonb language sql stable security definer set search_path = public as $$
  select data from public.hris_docs where collection = col and col in ('employees', 'leaves', 'permits');
$$;
revoke all on function public.hris_jotform_docs(text) from public, anon, authenticated;
grant execute on function public.hris_jotform_docs(text) to service_role;

select 'ok' as result;
