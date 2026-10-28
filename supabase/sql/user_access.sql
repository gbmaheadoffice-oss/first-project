-- HRIS user access (Settings → User access, edge function hris-admin).
-- An account's access is app_metadata.hris_role: admin | staff | viewer (none = staff, for accounts made before this).
-- Viewers and turned-off accounts may not add, change or delete records or files. The check reads auth.users on every write, so a change in Settings applies at once.
create or replace function public.hris_can_write()
returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (
    select 1 from auth.users
    where id = auth.uid()
      and coalesce(raw_app_meta_data->>'hris_role', 'staff') in ('admin', 'staff')
      and (banned_until is null or banned_until < now())
  );
$$;
revoke all on function public.hris_can_write() from public, anon;
grant execute on function public.hris_can_write() to authenticated;

-- turned-off accounts cannot read either
create or replace function public.hris_can_read()
returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (select 1 from auth.users where id = auth.uid() and (banned_until is null or banned_until < now()));
$$;
revoke all on function public.hris_can_read() from public, anon;
grant execute on function public.hris_can_read() to authenticated;

drop policy if exists "staff write" on public.hris_docs;
drop policy if exists "staff read" on public.hris_docs;
create policy "staff read" on public.hris_docs for select to authenticated using (public.hris_can_read());
create policy "staff insert" on public.hris_docs for insert to authenticated with check (public.hris_can_write());
create policy "staff update" on public.hris_docs for update to authenticated using (public.hris_can_write()) with check (public.hris_can_write());
create policy "staff delete" on public.hris_docs for delete to authenticated using (public.hris_can_write());

drop policy if exists "hris files read" on storage.objects;
drop policy if exists "hris files add" on storage.objects;
drop policy if exists "hris files remove" on storage.objects;
create policy "hris files read" on storage.objects for select to authenticated using (bucket_id = 'hris-files' and public.hris_can_read());
create policy "hris files add" on storage.objects for insert to authenticated with check (bucket_id = 'hris-files' and public.hris_can_write());
create policy "hris files remove" on storage.objects for delete to authenticated using (bucket_id = 'hris-files' and public.hris_can_write());

-- the HRIS owner account is the first admin
update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data, '{}') || '{"hris_role":"admin"}'
where email = 'gbmaheadoffice@gmail.com';

select 'ok' as result;
