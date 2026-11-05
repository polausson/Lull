# Lull — a two-phone baby monitor (PWA)

One phone stays in the nursery and listens. The other phone gets an alert when the baby makes a sound and can play back a short clip of what was heard. No App Store, no native app, near-zero running cost.

> **Lull is not a medical device.** It can miss sounds or alerts (dead battery, lost Wi‑Fi, the phone locking itself, OS updates). Use it as a convenience, never as a safety system.

---

## 1. iOS feasibility — what actually works

These are the platform facts the whole design is built around.

| Question | Answer | What Lull does about it |
|---|---|---|
| Can the mic keep recording when the screen locks? | **No (iOS).** iPhone suspends microphone capture for web apps when the screen locks; Home Screen web apps are affected too. Android Chrome usually keeps capturing, but background timers get throttled. | The Baby Unit is designed to stay **open, on screen, plugged in**. It holds a Screen Wake Lock (works in Home Screen apps since iOS 18.4) and offers a black **Dim screen** mode. If wake lock isn't available it tells you to set Auto-Lock to Never. |
| Can monitoring continue in the background? | **No (iOS).** Switching apps stops audio. | The app detects it (no audio frames, suspended audio context, page hidden) and immediately reports "not listening". A server watchdog alerts the parent phone within ~1–2 minutes even if the baby phone goes completely silent. |
| Can the Parent Unit get notifications while locked? | **Yes**, on iOS 16.4+ **only if Lull is added to the Home Screen** and notifications are allowed from a tap. Android Chrome works from the browser too. | Parent Mode detects iOS-in-Safari and explains how to add to Home Screen first. |
| Can the Baby Unit play white noise while listening? | **Yes, while in the foreground.** Both run in one shared Web Audio context, and the audio session is set to play-and-record on Safari. Playback stops if the app is backgrounded. | Sleep sounds are synthesized live (no audio files). Starting/stopping/changing volume triggers a 3–4 s **noise-floor recalibration**, so steady white noise doesn't count as a sound. Echo cancellation is requested too, but not relied on. **Test the speaker volume on your own iPhone**: on some devices output can be quieter while the mic is active; a separate speaker is the fallback. |
| Is detection reliable over long sessions? | **Yes, if the app stays in the foreground.** | Health is derived from actual audio frames, not from intent. If frames stop for 2.5 s, the mic track mutes/ends, or the audio context is interrupted, the app shows "Listening stopped", reports it in the heartbeat, and auto-restarts when possible ("Resume listening" button if iOS needs a tap). |

**Golden rule implemented everywhere:** "Listening" is only shown when microphone frames are arriving *and* (on the parent) a heartbeat less than 35 s old says so. Otherwise it says *Not listening*, *Paused*, *Offline* or *Status unknown*.

### Recommended nursery setup
- Plug the baby phone in. Open Lull from the Home Screen, tap **Start listening**, then **Dim screen**.
- iPhone tip: **Guided Access** (Settings → Accessibility → Guided Access) keeps Lull locked in the foreground so nobody can accidentally switch away.
- Put the phone 1–2 m from the cot, not on the mattress.

---

## 2. Architecture

```
 Baby phone (PWA)                         Supabase (free tier)                    Parent phone (PWA)
 ┌──────────────────────────┐   heartbeat  ┌───────────────────────────┐  realtime   ┌───────────────────────┐
 │ Mic → AudioWorklet       │─────10 s────▶│ Postgres + RLS            │────────────▶│ Status, timeline,     │
 │  → level → noise floor   │              │  households, events,      │  poll 8 s   │ recordings, playback  │
 │  → detector (300 ms)     │  insert evt  │  push subscriptions       │◀────────────│ (signed URLs, 5 min)  │
 │  → 5 s ring buffer       │─────────────▶│ Storage (private bucket)  │             └───────────▲───────────┘
 │  → WAV 16 kHz clip       │  upload WAV  │ Edge fn notify-sound ─────┼──Web Push──────────────┘
 │ White noise (Web Audio)  │─────────────▶│ Edge fn maintenance ◀ cron│  (watchdog + retention)
 └──────────────────────────┘              └───────────────────────────┘
```

- **Auth:** every phone gets an anonymous Supabase session (persisted on the device). No accounts, no emails.
- **Pairing:** the baby unit creates a household and a single-use 8-character code (31-symbol alphabet, ~850 billion combinations) valid for 10 minutes and stored only as a SHA-256 hash. A device gets locked out after 8 wrong codes in 10 minutes. Pairing is persistent; you can add more parent phones any time.
- **Access control:** Row Level Security on every table; all writes that matter go through `security definer` functions that check membership. Clips live in a private bucket under `<household>/<event>.wav` and are only reachable through 5-minute signed URLs for members.
- **Detection:** RMS level per ~21 ms frame; adaptive noise floor (falls fast, rises slowly); a sound must exceed `max(floor + margin, absolute minimum)` for 300 ms. Sensitivity moves both. Continuous sound keeps the clip open (max 45 s).
- **Clips:** the 5 s pre-roll comes from an in-memory ring buffer, then 10/15/20 s after (configurable). Encoded as 16 kHz mono WAV (~32 KB/s): plays natively on every iPhone and Android, and avoids MediaRecorder's inconsistent formats. *Why not MediaRecorder:* it can't record the 5 seconds before the trigger, and its output format differs between Safari (MP4/AAC) and Chrome (WebM/Opus).
- **Notifications:** sent the moment the sound starts (before the clip finishes), so alerts arrive within a second or two. Duplicate protection on both sides: the baby unit's alert cooldown (default 1 min, clips still saved) and an atomic server-side 20 s floor.
- **Watchdog:** a cron job every minute alerts parents when a monitoring baby unit hasn't sent a heartbeat for 60 s or reports a dead mic for 30 s, and again when it recovers. A deliberate "Stop listening" clears this silently.
- **Retention:** clips and rows are deleted after the household's retention period (default 24 h; 12 h–7 days in Parent settings).
- **Web Push:** implemented directly on WebCrypto (VAPID + aes128gcm), no dependencies.

### Project layout
```
src/audio/       detector.ts (detection), pcm.ts (ring buffer, resampler, WAV), monitor.ts (engine), noise.ts, context.ts
src/hooks/       useBabyUnit.ts, useParentUnit.ts, useWakeLock.ts, …
src/screens/     Welcome, PairCode, BabyScreen, ParentScreen, Settings
src/components/  ui.tsx, Orb.tsx (listening visual), NightStrip.tsx (timeline)
src/sw.ts        service worker: offline shell, push, notification taps
public/          capture-worklet.js, icons
supabase/        migrations/ (schema + RLS), functions/ (notify-sound, maintenance), cron.sql, tests/
tests/           detection, PCM/WAV and Web Push crypto tests
```

---

## 3. Setup (≈30 minutes)

You need: a Supabase account (free), a static host (Netlify, Cloudflare Pages or Vercel — all free), Node 20+, and the Supabase CLI (`npm i -g supabase` or `brew install supabase/tap/supabase`).

### 3.1 Supabase project
1. Create a project at supabase.com. Pick a region near you (e.g. Stockholm `eu-north-1`).
2. **Authentication → Sign In / Providers → enable "Allow anonymous sign-ins".**
3. Apply the schema, either:
   - CLI: `supabase login && supabase link --project-ref <ref> && supabase db push`, or
   - Dashboard: paste `supabase/migrations/20261104000000_init.sql` into the SQL editor and run it.

### 3.2 Push keys and functions
```bash
npx web-push generate-vapid-keys          # prints a Public Key and a Private Key

supabase secrets set \
  VAPID_PUBLIC_KEY=<public key> \
  VAPID_PRIVATE_KEY=<private key> \
  VAPID_SUBJECT=mailto:you@example.com \
  CRON_SECRET=$(openssl rand -hex 24)      # note this value for step 3.3

supabase functions deploy notify-sound
supabase functions deploy maintenance --no-verify-jwt
```
The functions use the automatically provided `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. If your project only has the newer secret keys, also run `supabase secrets set SERVICE_ROLE_KEY=<secret key>`.

### 3.3 Watchdog + retention schedule
Open `supabase/cron.sql`, replace `<PROJECT_REF>` and `<CRON_SECRET>`, and run it in the SQL editor. Check it under **Integrations → Cron** after a minute.

### 3.4 Frontend
```bash
cp .env.example .env     # fill in URL, anon/publishable key, VAPID public key
npm install
npm run build            # outputs dist/
npm run typecheck        # optional: full TypeScript check
```
Deploy `dist/` to any static host with HTTPS (required for the microphone, service worker and push):
- **Netlify:** drag the `dist` folder onto app.netlify.com/drop, or connect the repo with build command `npm run build`, publish dir `dist`, and the three `VITE_` variables.
- **Cloudflare Pages / Vercel:** same build command and output dir.

### 3.5 Local development
`npm run dev` serves on your network. Phones need HTTPS for the mic, so for phone testing use the deployed URL (or a tunnel such as `npx cloudflared tunnel --url http://localhost:5173`).

---

## 4. Testing between two real phones

1. **Parent phone (do this first on iPhone):** open the site in Safari → Share → **Add to Home Screen** → open Lull from the Home Screen.
2. **Baby phone:** open Lull (Home Screen too, so wake lock works) → **Baby unit**. A code appears.
3. **Parent phone:** **Parent unit** → type the code → **Turn on alerts** → allow notifications.
4. Baby phone shows "Parent phone connected" and later "Alerts go to 1 parent phone".
5. **Start listening** on the baby phone. Wait ~4 s while it learns the room ("Learning the room's sound").
6. **Sound test:** lock the parent phone. Clap or talk near the baby phone for a second or two. Expect a notification within a few seconds; tap it — Lull opens with that recording highlighted. The clip becomes playable ~15 s later.
7. **Cooldown test:** make noise again within a minute: a new recording appears, no second alert.
8. **White noise test:** start Rain at a comfortable volume. After the brief recalibration, no alerts should fire from the rain itself; a loud clap still should. If rain triggers alerts, lower the sensitivity.
9. **Failure tests (important):**
   - Press the baby phone's side button to lock it. Within ~1–2 minutes the parent phone gets **"Baby unit stopped listening"** and the dashboard turns to *Not listening*. Unlock and reopen Lull: tap **Resume listening** if prompted; the parent gets "listening again".
   - Turn on airplane mode on the baby phone: the parent gets **"Baby unit disconnected"** after ~1–2 minutes.
   - Turn on airplane mode on the parent phone: its dashboard shows *Status unknown* — never a false "Listening".
10. **Diagnostics:** each phone's settings sheet has a log (copyable) of audio, network and push events.

Tuning: *Sensitivity* (Baby → main screen), *Recording after a sound* and *Wait between alerts* (Baby → settings), *Keep recordings for* (Parent → settings).

---

## 5. Running costs

Everything fits comfortably in free tiers for one family:

| Item | Usage estimate | Cost |
|---|---|---|
| Supabase (DB, auth, storage, functions) | ~640 KB per 20 s clip; 50 clips/night ≈ 32 MB, deleted after 24 h. ~45k cron calls + a few hundred notify calls per month. Free plan: 500 MB DB, 1 GB storage, 5 GB bandwidth, 500k function calls/month. | **$0** |
| Web Push (Apple / Google push services) | — | **$0** |
| Static hosting (Netlify / Cloudflare Pages / Vercel) | a few MB | **$0** |
| Custom domain (optional) | — | ~$10–15/year |

Caveat: **Supabase pauses free projects after a week of inactivity.** Nightly use keeps it awake; after a holiday, restore it from the dashboard. The Pro plan ($25/month) removes pausing if you ever need that guarantee.

---

## 6. What has been verified, and what needs your phones

Verified in the build environment:
- **Database:** the migration runs on PostgreSQL with Supabase-style auth/storage stubs; `npm run test:sql` checks pairing, single-use codes, brute-force lockout, RLS isolation between households (events, storage, subscriptions), heartbeat semantics, notification dedupe, watchdog lost/recovered detection, and retention.
- **Push crypto:** `npm test` decrypts Lull's push payloads with an independent RFC 8291 implementation and verifies VAPID signatures.
- **Detection:** tests for quiet rooms, short clicks (ignored), white noise (absorbed after calibration), fans, and sensitivity levels.
- **End to end in Chromium** with a simulated microphone (quiet room → 3 s cry): one detection, immediate notify call, a 20 s clip (5 s before + 15 s after) uploaded and marked ready; all screens rendered without errors.

Needs real devices and your Supabase project (can't be verified without them):
- Actual delivery of push notifications by Apple/Google.
- iOS-specific audio behaviour: white-noise volume while the mic is active, wake lock on your iOS version, how quickly iOS suspends audio.
- Detection thresholds against your nursery and your baby — adjust sensitivity on the first nights.

---

## 7. Ideas for later
Live listen-in (WebRTC), cry vs. noise classification, battery level in the heartbeat, a native wrapper (Capacitor) if background listening on iPhone ever becomes essential — that is the one thing a PWA cannot do.
