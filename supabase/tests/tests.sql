-- Behavioural tests for the migration. Each failed assertion raises an exception.
\set baby   '''11111111-1111-4111-8111-111111111111'''
\set parent '''22222222-2222-4222-8222-222222222222'''
\set stranger '''33333333-3333-4333-8333-333333333333'''
\set parent2 '''44444444-4444-4444-8444-444444444444'''

insert into auth.users values (:baby), (:parent), (:stranger), (:parent2);

create temp table ctx (k text primary key, v text);
grant all on ctx to authenticated, service_role;

create or replace function pg_temp.expect_error(sql text, fragment text) returns void language plpgsql as $$
begin
  execute sql;
  raise exception 'expected error containing "%" but statement succeeded: %', fragment, sql;
exception when others then
  if sqlerrm like 'expected error%' then raise; end if;
  if position(fragment in sqlerrm) = 0 then
    raise exception 'expected error containing "%", got "%"', fragment, sqlerrm;
  end if;
end $$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

-- 1. Baby creates household and a pairing code -----------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', :baby, false);
insert into ctx select 'h', public.create_household('Nursery')::text;
do $$ begin
  assert (select public.create_household()) = (select v::uuid from ctx where k='h'), 'create_household is idempotent';
end $$;
insert into ctx select 'code', code from public.create_pairing_code();
do $$ declare c text := (select v from ctx where k='code'); begin
  assert c ~ '^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$', 'code format: ' || c;
end $$;

-- 2. Stranger cannot see anything, cannot guess codes -------------------------
select set_config('request.jwt.claim.sub', :stranger, false);
do $$ begin
  assert (select count(*) from public.households) = 0, 'stranger sees no households';
  assert (select count(*) from public.get_status()) = 0, 'stranger has no status';
  assert public.claim_pairing_code('AAAA-AAAA') is null, 'wrong code returns null';
  perform pg_temp.expect_error($q$select public.create_pairing_code()$q$, 'only the baby unit');
  perform pg_temp.expect_error($q$select * from public.pairing_codes$q$, 'permission denied');
  perform pg_temp.expect_error($q$select public.watchdog_scan()$q$, 'permission denied');
  perform pg_temp.expect_error($q$insert into public.households default values$q$, 'permission denied');
end $$;
-- brute force lockout after 8 failures
do $$ begin
  for i in 1..7 loop
    assert public.claim_pairing_code('ZZZZ-ZZZZ') is null, 'wrong code';
  end loop;
  perform pg_temp.expect_error(format('select public.claim_pairing_code(%L)', (select v from ctx where k='code')), 'too many attempts');
end $$;

-- 3. Parent claims the code (lowercase, no dash works too) ---------------------
select set_config('request.jwt.claim.sub', :parent, false);
do $$ begin
  assert public.claim_pairing_code(lower(replace((select v from ctx where k='code'), '-', '')), 'Patrik phone')
         = (select v::uuid from ctx where k='h'), 'parent joins household';
  assert (select role from public.get_status()) = 'parent', 'parent role';
  assert (select parent_count from public.get_status()) = 1, 'parent count';
end $$;
-- single-use
select set_config('request.jwt.claim.sub', :parent2, false);
do $$ begin
  assert public.claim_pairing_code((select v from ctx where k='code')) is null, 'code is single-use';
end $$;

-- 4. Heartbeat + status semantics --------------------------------------------
select set_config('request.jwt.claim.sub', :baby, false);
select public.baby_heartbeat(true, true, 'listening');
select set_config('request.jwt.claim.sub', :parent, false);
do $$ declare s record; begin
  select * into s from public.get_status();
  assert s.monitoring and s.audio_ok, 'monitoring reported';
  assert s.heartbeat_age_seconds < 5, 'fresh heartbeat';
  perform pg_temp.expect_error($q$select public.baby_heartbeat(true, true)$q$, 'not a baby unit');
end $$;
-- audio_ok can never be true while not monitoring
select set_config('request.jwt.claim.sub', :baby, false);
select public.baby_heartbeat(false, true, 'stopped');
do $$ begin assert not (select audio_ok from public.get_status()), 'audio_ok false when not monitoring'; end $$;

-- 5. Sound events & storage RLS ----------------------------------------------
select public.baby_heartbeat(true, true, 'listening');
with ins as (
  insert into public.sound_events (household_id, peak_db, above_floor_db)
  select v::uuid, -20, 25 from ctx where k='h' returning id)
insert into ctx select 'e', id::text from ins;
update public.sound_events set status='ready', duration_ms=17000, storage_path='p' where id = (select v::uuid from ctx where k='e');
insert into storage.objects (bucket_id, name) select 'recordings', v || '/a.wav' from ctx where k='h';
do $$ begin
  perform pg_temp.expect_error($q$update public.sound_events set household_id = gen_random_uuid()$q$, 'permission denied');
end $$;

select set_config('request.jwt.claim.sub', :parent, false);
do $$ begin
  assert (select count(*) from public.sound_events) = 1, 'parent sees event';
  assert (select count(*) from storage.objects where bucket_id='recordings') = 1, 'parent sees object';
  perform pg_temp.expect_error(format($q$insert into public.sound_events (household_id) values (%L)$q$, (select v from ctx where k='h')), 'row-level security');
  perform pg_temp.expect_error(format($q$insert into storage.objects (bucket_id, name) values ('recordings', %L)$q$, (select v from ctx where k='h') || '/x.wav'), 'row-level security');
end $$;

select set_config('request.jwt.claim.sub', :stranger, false);
do $$ begin
  assert (select count(*) from public.sound_events) = 0, 'stranger sees no events';
  assert (select count(*) from storage.objects) = 0, 'stranger sees no objects';
  delete from public.sound_events;   -- silently affects 0 rows
end $$;

-- 6. Push subscriptions -------------------------------------------------------
select set_config('request.jwt.claim.sub', :parent, false);
select public.save_push_subscription('https://push.example/abc', 'key', 'auth');
select public.save_push_subscription('https://push.example/abc', 'key2', 'auth2', false);
do $$ begin
  assert (select count(*) from public.push_subscriptions) = 1, 'upsert by endpoint';
  assert not (select sound_alerts from public.push_subscriptions), 'alerts toggled';
  perform public.set_sound_alerts(true);
  assert (select sound_alerts from public.push_subscriptions), 'alerts re-enabled';
  assert (select alert_device_count from public.get_status()) = 1, 'alert device counted';
end $$;
select set_config('request.jwt.claim.sub', :baby, false);
do $$ begin
  perform pg_temp.expect_error($q$select public.save_push_subscription('https://x', 'a', 'b')$q$, 'only parent units');
  assert (select count(*) from public.push_subscriptions) = 0, 'baby cannot read parent subscriptions';
end $$;

-- 7. Service role: notify dedupe, watchdog, retention --------------------------
reset role;
set role service_role;
do $$ declare h uuid := (select v::uuid from ctx where k='h'); begin
  assert public.try_claim_notify(h, 20), 'first notify claimed';
  assert not public.try_claim_notify(h, 20), 'second notify deduped';

  -- healthy: nothing to report
  assert (select count(*) from public.watchdog_scan()) = 0, 'no alerts while healthy';
  -- simulate a stale heartbeat
  update public.households set last_heartbeat = now() - interval '2 minutes' where id = h;
  assert (select kind from public.watchdog_scan()) = 'lost', 'lost detected';
  assert (select count(*) from public.watchdog_scan()) = 0, 'lost alerted once';
  -- recovery
  update public.households set last_heartbeat = now(), audio_ok = true, audio_lost_at = null where id = h;
  assert (select kind from public.watchdog_scan()) = 'recovered', 'recovery detected';
  -- audio lost while heartbeat fresh
  update public.households set audio_ok = false, audio_lost_at = now() - interval '45 seconds' where id = h;
  assert (select detail from public.watchdog_scan()) = 'no_audio', 'no_audio detected';

  -- retention
  update public.sound_events set created_at = now() - interval '25 hours';
  assert (select count(*) from public.expired_events()) = 1, 'expired after 24h';
  update public.households set retention_hours = 48 where id = h;
  assert (select count(*) from public.expired_events()) = 0, 'retention respected';
  perform public.housekeeping();
end $$;

-- 8. Deliberate stop clears pending alert; leave_household ----------------------
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', :baby, false);
select public.baby_heartbeat(false, false, 'stopped');
reset role;
do $$ begin assert (select offline_alerted_at is null from public.households), 'stop clears alert'; end $$;
set role authenticated;
select set_config('request.jwt.claim.sub', :parent, false);
select public.leave_household();
do $$ begin
  assert (select count(*) from public.get_status()) = 0, 'parent unpaired';
  assert (select count(*) from public.push_subscriptions) = 0, 'subscription removed';
end $$;
