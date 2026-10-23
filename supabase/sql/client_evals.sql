-- Google Form "CLIENT'S FEEDBACK & PERFORMANCE EVALUATION FORM" -> hris_docs 'clientevals' (via the gform-eval function).
-- Each row is {id, data}. A response edited in Google Forms is refreshed; a link to an employee that HR set
-- by hand is kept when the typed name no longer matches anyone.
create or replace function public.hris_upsert_client_evals(rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare r jsonb; d jsonb; nd jsonb; k text; n integer := 0;
begin
  for r in select * from jsonb_array_elements(rows) loop
    nd := (r->'data') || jsonb_build_object('id', r->>'id');
    select data into d from public.hris_docs where collection = 'clientevals' and id = r->>'id' for update;
    if not found then
      insert into public.hris_docs (collection, id, data, updated_at)
      values ('clientevals', r->>'id', nd || jsonb_build_object('updatedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), now());
      n := n + 1;
      continue;
    end if;
    foreach k in array array['employeeId', 'period'] loop
      if coalesce(nd->>k, '') = '' and coalesce(d->>k, '') <> '' then nd := nd || jsonb_build_object(k, d->k); end if;
    end loop;
    if nd is distinct from (d - 'updatedAt') then
      update public.hris_docs set data = nd || jsonb_build_object('updatedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
        updated_at = now() where collection = 'clientevals' and id = r->>'id';
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke all on function public.hris_upsert_client_evals(jsonb) from public, anon, authenticated;
grant execute on function public.hris_upsert_client_evals(jsonb) to service_role;

select 'ok' as result;
