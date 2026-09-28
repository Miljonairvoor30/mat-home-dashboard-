-- Run through the Supabase SQL editor with project administrator privileges.
-- This job is active in project kqizlvzcfncfyriwnmpl.
-- The token itself stays in Vault; only its SHA-256 hash is in bol-sync-mvp.
create extension if not exists pg_net with schema extensions;
create unique index if not exists sync_runs_one_bol_mvp_running
on public.sync_runs(source) where status='running' and source='bol_mvp';
select cron.schedule('mat-home-bol-sync-every-five-minutes','*/5 * * * *',$job$
select net.http_post(
  url:='https://kqizlvzcfncfyriwnmpl.supabase.co/functions/v1/bol-sync-mvp',
  headers:=jsonb_build_object('Content-Type','application/json','x-sync-token',
    (select decrypted_secret from vault.decrypted_secrets where name='mat_home_sync_cron')),
  body:=jsonb_build_object('mode',case when extract(minute from now())::int=0 then 'full' else 'fast' end),
  timeout_milliseconds:=120000
);
$job$);
