-- Jotform applicants -> hris_docs (collection 'applicants').
-- New submissions start as status 'New'. Re-syncs only refresh the applicant's answers (form, jotform),
-- never HR's own fields (status, notes, history, hiredEmployeeId).
create or replace function public.hris_upsert_applicants(rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare r jsonb; n integer := 0; c integer;
begin
  for r in select * from jsonb_array_elements(rows) loop
    insert into public.hris_docs (collection, id, data, updated_at)
    values ('applicants', r->>'id', jsonb_build_object(
        'id', r->>'id', 'source', 'jotform', 'status', 'New',
        'form', r->'form', 'jotform', r->'meta',
        'createdAt', to_char((r->'meta'->>'createdAt')::timestamp, 'YYYY-MM-DD"T"HH24:MI:SS'),
        'updatedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), now())
    on conflict (collection, id) do update
      set data = hris_docs.data || jsonb_build_object('form', excluded.data->'form', 'jotform', excluded.data->'jotform'),
          updated_at = now()
      where hris_docs.data->'form' is distinct from excluded.data->'form';
    get diagnostics c = row_count; n := n + c;
  end loop;
  return n;
end $$;
revoke all on function public.hris_upsert_applicants(jsonb) from public, anon, authenticated;
grant execute on function public.hris_upsert_applicants(jsonb) to service_role;

create index if not exists hris_docs_applicant_created on public.hris_docs ((data->'jotform'->>'createdAt')) where collection = 'applicants';

create or replace view public.applicants with (security_invoker = true) as
select d.id,
  d.data->>'status' as status,
  -- Jotform's API gives US Eastern time, date_applied is the Philippine date
  to_char(((d.data->'jotform'->>'createdAt')::timestamp at time zone 'America/New_York') at time zone 'Asia/Manila', 'YYYY-MM-DD') as date_applied,
  d.data->'form'->>'position' as position,
  d.data->'form'->>'lastName' as last_name, d.data->'form'->>'firstName' as first_name, d.data->'form'->>'middleName' as middle_name,
  d.data->'form'->>'mobile' as mobile, d.data->'form'->>'email' as email,
  d.data->'form'->>'presentAddress' as present_address,
  d.data->'form'->>'age' as age, d.data->'form'->>'gender' as gender, d.data->'form'->>'civilStatus' as civil_status,
  d.data->'form'->>'desiredSalary' as desired_salary, d.data->'form'->>'availableFrom' as available_from,
  d.data->>'notes' as hr_notes, d.data->>'hiredEmployeeId' as hired_employee_id,
  d.data->'jotform'->>'submissionId' as jotform_submission_id,
  d.updated_at as last_saved, d.data as all_details
from public.hris_docs d where d.collection = 'applicants';
revoke all on public.applicants from anon;
grant select on public.applicants to authenticated;

select 'ok' as result;

-- Newest Jotform submission time already stored (used by jotform-sync to fetch only new ones).
create or replace function public.hris_applicants_last_created()
returns text language sql stable security definer set search_path = public as $$
  select max(data->'jotform'->>'createdAt') from public.hris_docs where collection = 'applicants';
$$;
revoke all on function public.hris_applicants_last_created() from public, anon, authenticated;
grant execute on function public.hris_applicants_last_created() to service_role;
