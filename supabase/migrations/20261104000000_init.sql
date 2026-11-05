-- Lull baby monitor — initial schema
-- Every device signs in with a Supabase anonymous session. A household links one
-- Baby Unit with one or more Parent Units. All access is checked against
-- household membership with Row Level Security.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.households (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  retention_hours    int not null default 24 check (retention_hours between 1 and 168),
  -- Baby Unit status (written only through baby_heartbeat()).
  baby_user_id       uuid references auth.users (id) on delete set null,
  monitoring         boolean not null default false,  -- the Baby Unit intends to monitor
  audio_ok           boolean not null default false,  -- microphone frames are actually flowing
  audio_lost_at      timestamptz,                     -- when audio_ok last went false while monitoring
  status_detail      text,
  last_heartbeat     timestamptz,
  -- Notification bookkeeping (service role only).
  last_notified_at   timestamptz,
  offline_alerted_at timestamptz
);

create table public.household_members (
  household_id uuid not null references public.households (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  role         text not null check (role in ('baby', 'parent')),
  device_label text check (char_length(device_label) <= 40),
  created_at   timestamptz not null default now(),
  primary key (household_id, user_id),
  unique (user_id) -- a device belongs to exactly one household
);

create table public.pairing_codes (
  code_hash    text primary key,
  household_id uuid not null references public.households (id) on delete cascade,
  created_by   uuid not null references auth.users (id) on delete cascade,
  expires_at   timestamptz not null
);

create table public.pairing_attempts (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  created_at timestamptz not null default now(),
  success    boolean not null
);
create index pairing_attempts_user_idx on public.pairing_attempts (user_id, created_at);

create table public.sound_events (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.households (id) on delete cascade,
  created_at     timestamptz not null default now(),
  peak_db        real,      -- loudest level in the clip, dBFS
  above_floor_db real,      -- how far the sound rose above the room's noise floor
  duration_ms    int check (duration_ms between 0 and 120000),
  storage_path   text,
  status         text not null default 'recording' check (status in ('recording', 'ready', 'failed')),
  notified       boolean not null default false
);
create index sound_events_household_created_idx on public.sound_events (household_id, created_at desc);

create table public.push_subscriptions (
  endpoint     text primary key,
  user_id      uuid not null references auth.users (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  p256dh       text not null,
  auth         text not null,
  sound_alerts boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index push_subscriptions_household_idx on public.push_subscriptions (household_id);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.my_household()
returns uuid language sql stable security definer set search_path = public as $$
  select household_id from household_members where user_id = auth.uid()
$$;

create or replace function public.my_role()
returns text language sql stable security definer set search_path = public as $$
  select role from household_members where user_id = auth.uid()
$$;

create or replace function public.is_member(h uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from household_members where household_id = h and user_id = auth.uid())
$$;

create or replace function public.is_baby_unit(h uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from household_members
                 where household_id = h and user_id = auth.uid() and role = 'baby')
$$;

create or replace function public.normalize_code(p text)
returns text language sql immutable as $$
  select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

create or replace function public.hash_code(p text)
returns text language sql immutable as $$
  select encode(sha256(convert_to(public.normalize_code(p), 'UTF8')), 'hex')
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.households         enable row level security;
alter table public.household_members  enable row level security;
alter table public.pairing_codes      enable row level security;  -- no policies: RPC only
alter table public.pairing_attempts   enable row level security;  -- no policies: RPC only
alter table public.sound_events       enable row level security;
alter table public.push_subscriptions enable row level security;

create policy "members read household" on public.households
  for select to authenticated using (public.is_member(id));

create policy "members read members" on public.household_members
  for select to authenticated using (public.is_member(household_id));

create policy "members read events" on public.sound_events
  for select to authenticated using (public.is_member(household_id));
create policy "members delete events" on public.sound_events
  for delete to authenticated using (public.is_member(household_id));
create policy "baby unit inserts events" on public.sound_events
  for insert to authenticated with check (public.is_baby_unit(household_id));
create policy "baby unit updates events" on public.sound_events
  for update to authenticated
  using (public.is_baby_unit(household_id)) with check (public.is_baby_unit(household_id));

create policy "own subscriptions read" on public.push_subscriptions
  for select to authenticated using (user_id = auth.uid());
create policy "own subscriptions delete" on public.push_subscriptions
  for delete to authenticated using (user_id = auth.uid());

-- Column-level hardening: clients may only change what they need to.
revoke update on public.sound_events from authenticated;
grant update (duration_ms, storage_path, status, peak_db, above_floor_db) on public.sound_events to authenticated;
revoke all on public.pairing_codes, public.pairing_attempts from anon, authenticated;
revoke insert, update, delete on public.households, public.household_members, public.push_subscriptions from anon, authenticated;
grant delete on public.push_subscriptions to authenticated;
revoke all on public.households, public.household_members, public.sound_events, public.push_subscriptions from anon;

-- ---------------------------------------------------------------------------
-- RPCs used by the app
-- ---------------------------------------------------------------------------

-- Baby Unit: create (or return) this device's household.
create or replace function public.create_household(p_label text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  h uuid;
  r text;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select household_id, role into h, r from household_members where user_id = uid;
  if h is not null then
    if r <> 'baby' then raise exception 'this device is already paired as a parent unit'; end if;
    return h;
  end if;
  insert into households (baby_user_id) values (uid) returning id into h;
  insert into household_members (household_id, user_id, role, device_label)
    values (h, uid, 'baby', left(p_label, 40));
  return h;
end $$;

-- Baby Unit: issue a fresh single-use pairing code (valid 10 minutes).
create or replace function public.create_pairing_code()
returns table (code text, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  h uuid;
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; -- 31 chars, no 0/O/1/I/L
  raw bytea := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid());
  c text := '';
  i int;
  exp timestamptz := now() + interval '10 minutes';
begin
  select hm.household_id into h from household_members hm where hm.user_id = uid and hm.role = 'baby';
  if h is null then raise exception 'only the baby unit can create pairing codes'; end if;
  -- bytes 6 and 8 of a v4 UUID carry version/variant bits; skip them.
  for i in 0..7 loop
    c := c || substr(alphabet, (get_byte(raw, (array[0,1,2,3,4,5,7,9])[i+1]) % 31) + 1, 1);
  end loop;
  delete from pairing_codes pc where pc.household_id = h;
  insert into pairing_codes (code_hash, household_id, created_by, expires_at)
    values (hash_code(c), h, uid, exp);
  return query select substr(c, 1, 4) || '-' || substr(c, 5, 4), exp;
end $$;

-- Parent Unit: redeem a pairing code. Returns the household id, or null if the code is wrong/expired.
create or replace function public.claim_pairing_code(p_code text, p_label text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  h uuid;
  recent_failures int;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if exists (select 1 from household_members where user_id = uid) then
    raise exception 'this device is already paired';
  end if;
  select count(*) into recent_failures from pairing_attempts
    where user_id = uid and not success and created_at > now() - interval '10 minutes';
  if recent_failures >= 8 then
    raise exception 'too many attempts, wait a few minutes';
  end if;

  delete from pairing_codes
    where code_hash = hash_code(p_code) and expires_at > now()
    returning household_id into h;

  insert into pairing_attempts (user_id, success) values (uid, h is not null);
  -- Return null rather than raising: an exception would roll back the attempt
  -- record and defeat the brute-force limit above.
  if h is null then return null; end if;

  insert into household_members (household_id, user_id, role, device_label)
    values (h, uid, 'parent', left(p_label, 40));
  return h;
end $$;

-- Both units: everything the UI needs, with ages computed on the server clock.
create or replace function public.get_status()
returns table (
  household_id uuid,
  role text,
  retention_hours int,
  monitoring boolean,
  audio_ok boolean,
  status_detail text,
  last_heartbeat timestamptz,
  heartbeat_age_seconds double precision,
  parent_count int,
  alert_device_count int,
  server_time timestamptz
) language sql stable security definer set search_path = public as $$
  select h.id, m.role, h.retention_hours, h.monitoring, h.audio_ok, h.status_detail,
         h.last_heartbeat,
         extract(epoch from (now() - h.last_heartbeat)),
         (select count(*)::int from household_members x where x.household_id = h.id and x.role = 'parent'),
         (select count(*)::int from push_subscriptions s where s.household_id = h.id),
         now()
  from household_members m join households h on h.id = m.household_id
  where m.user_id = auth.uid()
$$;

-- Baby Unit: report liveness. Called every ~10 s while the app is open.
create or replace function public.baby_heartbeat(p_monitoring boolean, p_audio_ok boolean, p_detail text default null)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare
  h uuid;
begin
  select household_id into h from household_members where user_id = auth.uid() and role = 'baby';
  if h is null then raise exception 'not a baby unit'; end if;
  update households set
    baby_user_id   = auth.uid(),
    monitoring     = p_monitoring,
    audio_ok       = p_monitoring and p_audio_ok,
    audio_lost_at  = case
                       when not p_monitoring or p_audio_ok then null
                       else coalesce(audio_lost_at, now())
                     end,
    status_detail  = left(p_detail, 120),
    last_heartbeat = now(),
    -- Deliberately stopping monitoring clears any pending "lost" alert silently.
    offline_alerted_at = case when p_monitoring then offline_alerted_at else null end
  where id = h;
  return now();
end $$;

-- Parent Unit: store or refresh this device's push subscription.
create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_sound_alerts boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare
  h uuid;
begin
  select household_id into h from household_members where user_id = auth.uid() and role = 'parent';
  if h is null then raise exception 'only parent units can subscribe'; end if;
  if p_endpoint !~ '^https://' then raise exception 'invalid endpoint'; end if;
  insert into push_subscriptions (endpoint, user_id, household_id, p256dh, auth, sound_alerts)
    values (p_endpoint, auth.uid(), h, p_p256dh, p_auth, p_sound_alerts)
  on conflict (endpoint) do update set
    user_id = excluded.user_id, household_id = excluded.household_id,
    p256dh = excluded.p256dh, auth = excluded.auth,
    sound_alerts = excluded.sound_alerts, updated_at = now();
end $$;

create or replace function public.set_sound_alerts(p_enabled boolean)
returns void language sql security definer set search_path = public as $$
  update push_subscriptions set sound_alerts = p_enabled, updated_at = now() where user_id = auth.uid()
$$;

create or replace function public.set_retention(p_hours int)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_hours not between 1 and 168 then raise exception 'retention must be 1–168 hours'; end if;
  update households set retention_hours = p_hours where id = my_household();
end $$;

-- Either unit: unpair this device.
create or replace function public.leave_household()
returns void language plpgsql security definer set search_path = public as $$
declare
  h uuid; r text;
begin
  select household_id, role into h, r from household_members where user_id = auth.uid();
  if h is null then return; end if;
  delete from push_subscriptions where user_id = auth.uid();
  delete from household_members where user_id = auth.uid();
  if r = 'baby' then
    update households set baby_user_id = null, monitoring = false, audio_ok = false,
      status_detail = 'baby unit unpaired', offline_alerted_at = null
    where id = h;
    delete from pairing_codes where household_id = h;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Service-role-only RPCs (edge functions)
-- ---------------------------------------------------------------------------

-- Atomically claim the right to send a sound notification (dedupe across retries).
create or replace function public.try_claim_notify(p_household uuid, p_min_interval_seconds int)
returns boolean language sql security definer set search_path = public as $$
  with u as (
    update households set last_notified_at = now()
    where id = p_household
      and (last_notified_at is null or last_notified_at < now() - make_interval(secs => p_min_interval_seconds))
    returning 1
  ) select exists (select 1 from u)
$$;

-- Find Baby Units that stopped listening (and ones that recovered), marking them.
create or replace function public.watchdog_scan()
returns table (household_id uuid, kind text, detail text)
language sql security definer set search_path = public as $$
  with lost as (
    update households set offline_alerted_at = now()
    where monitoring and offline_alerted_at is null and baby_user_id is not null
      and (last_heartbeat < now() - interval '60 seconds'
           or (audio_lost_at is not null and audio_lost_at < now() - interval '30 seconds'))
    returning id, 'lost'::text,
      case when last_heartbeat < now() - interval '60 seconds' then 'no_heartbeat' else 'no_audio' end
  ), recovered as (
    update households set offline_alerted_at = null
    where monitoring and offline_alerted_at is not null
      and last_heartbeat >= now() - interval '30 seconds' and audio_ok
    returning id, 'recovered'::text, null::text
  )
  select * from lost union all select * from recovered
$$;

create or replace function public.expired_events(p_limit int default 500)
returns table (id uuid, storage_path text)
language sql stable security definer set search_path = public as $$
  select e.id, e.storage_path from sound_events e join households h on h.id = e.household_id
  where e.created_at < now() - make_interval(hours => h.retention_hours)
  order by e.created_at limit p_limit
$$;

create or replace function public.housekeeping()
returns void language sql security definer set search_path = public as $$
  delete from pairing_codes where expires_at < now();
  delete from pairing_attempts where created_at < now() - interval '1 day';
  update sound_events set status = 'failed'
    where status = 'recording' and created_at < now() - interval '10 minutes';
$$;

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.create_household(text), public.create_pairing_code(), public.claim_pairing_code(text, text),
  public.get_status(), public.baby_heartbeat(boolean, boolean, text),
  public.save_push_subscription(text, text, text, boolean), public.set_sound_alerts(boolean),
  public.set_retention(int), public.leave_household(),
  public.my_household(), public.my_role(), public.is_member(uuid), public.is_baby_unit(uuid)
  to authenticated;
revoke execute on function
  public.try_claim_notify(uuid, int), public.watchdog_scan(), public.expired_events(int), public.housekeeping()
  from authenticated;
grant execute on function
  public.try_claim_notify(uuid, int), public.watchdog_scan(), public.expired_events(int), public.housekeeping()
  to service_role;

-- ---------------------------------------------------------------------------
-- Private storage for clips: recordings/<household_id>/<event_id>.wav
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recordings', 'recordings', false, 5242880, array['audio/wav'])
on conflict (id) do update set public = false;

create policy "members read recordings" on storage.objects
  for select to authenticated
  using (bucket_id = 'recordings' and public.is_member(((storage.foldername(name))[1])::uuid));

create policy "members delete recordings" on storage.objects
  for delete to authenticated
  using (bucket_id = 'recordings' and public.is_member(((storage.foldername(name))[1])::uuid));

create policy "baby unit uploads recordings" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'recordings' and public.is_baby_unit(((storage.foldername(name))[1])::uuid));

-- ---------------------------------------------------------------------------
-- Realtime: parents get new/updated sound events instantly (RLS still applies).
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table public.sound_events;
