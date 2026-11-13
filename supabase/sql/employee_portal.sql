-- Employee page (/employee/): accounts for deployed employees.
-- An employee account has app_metadata.hris_role = 'employee' and app_metadata.employee_id = the 201 record id.
-- Employee accounts must never read the HRIS tables or files directly: all they see comes from the edge
-- function hris-me, which returns only their own leaves, permits, overtime and memos.

-- turned-off accounts and employee accounts cannot read HRIS records or files
create or replace function public.hris_can_read()
returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (
    select 1 from auth.users
    where id = auth.uid()
      and coalesce(raw_app_meta_data->>'hris_role', 'staff') in ('admin', 'staff', 'viewer')
      and (banned_until is null or banned_until < now())
  );
$$;
revoke all on function public.hris_can_read() from public, anon;
grant execute on function public.hris_can_read() to authenticated;

-- staff names: only HRIS staff may list them (an account still reads and updates its own profile)
drop policy if exists "staff read profiles" on public.hris_profiles;
create policy "staff read profiles" on public.hris_profiles for select to authenticated using (public.hris_can_read());

-- sign-in email of the employee account linked to a 201 record (used only by the hris-me function)
create or replace function public.hris_employee_login_email(emp_id text)
returns text language sql stable security definer set search_path = public, auth as $$
  select email from auth.users
  where raw_app_meta_data->>'hris_role' = 'employee' and raw_app_meta_data->>'employee_id' = emp_id
  order by created_at desc limit 1;
$$;
revoke all on function public.hris_employee_login_email(text) from public, anon, authenticated;
grant execute on function public.hris_employee_login_email(text) to service_role;

select 'ok' as result;
