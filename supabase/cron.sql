-- Run once in the Supabase SQL editor AFTER deploying the `maintenance` function.
-- Replace <PROJECT_REF> and <CRON_SECRET> (the same value you set with `supabase secrets set CRON_SECRET=...`).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'lull-maintenance',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/maintenance',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<CRON_SECRET>'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $$
);

-- To remove later:  select cron.unschedule('lull-maintenance');
