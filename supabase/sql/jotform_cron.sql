-- Runs the jotform-sync function every 5 minutes. The token lives in Supabase Vault (name: jotform_sync_token).
create extension if not exists pg_net;
create extension if not exists pg_cron;

create or replace function public.hris_run_jotform_sync(p_full boolean default false)
returns bigint language sql security definer set search_path = public as $$
  select net.http_post(
    url := 'https://mgmbtqjgcmzeqsbdfnwp.supabase.co/functions/v1/jotform-sync',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-sync-token',(select decrypted_secret from vault.decrypted_secrets where name='jotform_sync_token')),
    body := jsonb_build_object('full', p_full),
    timeout_milliseconds := 150000);
$$;
revoke all on function public.hris_run_jotform_sync(boolean) from public, anon, authenticated;

select cron.unschedule('jotform-sync') where exists (select 1 from cron.job where jobname='jotform-sync');
select cron.schedule('jotform-sync', '*/5 * * * *', 'select public.hris_run_jotform_sync(false)');

-- First run: import all past applications
select public.hris_run_jotform_sync(true) as request_id;
