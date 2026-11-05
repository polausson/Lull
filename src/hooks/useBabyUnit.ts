// Baby Unit controller: microphone engine, white noise, heartbeat, clip upload.
import { useCallback, useEffect, useRef, useState } from 'react';
import { MonitorEngine, type MicError, type Health, type DetectorFrame, type AudioState, type ClipStart, type Clip } from '../audio/monitor';
import { NoisePlayer, type NoiseKind } from '../audio/noise';
import { encodeWav } from '../audio/pcm';
import type { BabyBackend } from '../lib/backend';
import { log } from '../lib/log';
import { useStored } from './useStored';
import { useWakeLock } from './useWakeLock';
import { useOnline } from './useOnline';

const HEARTBEAT_MS = 10_000;

export interface BabySettings {
  sensitivity: number;   // 0..1
  postRollS: 10 | 15 | 20;
  cooldownS: 30 | 60 | 120 | 300;
}

const DEFAULTS: BabySettings = { sensitivity: 0.6, postRollS: 15, cooldownS: 60 };

export type MicPermission = 'unknown' | 'granted' | 'denied' | 'prompt';

export function useBabyUnit(backend: BabyBackend) {
  const [settings, setSettings] = useStored<BabySettings>('lull-baby-settings', DEFAULTS);
  const [noise, setNoise] = useStored<{ kind: NoiseKind; volume: number }>('lull-noise', { kind: 'rain', volume: 0.45 });
  const [noisePlaying, setNoisePlaying] = useState(false);

  const [intent, setIntent] = useState(false);          // user wants monitoring on
  const [health, setHealth] = useState<Health>({ audioOk: false, reason: 'not started' });
  const [micError, setMicError] = useState<MicError | null>(null);
  const [permission, setPermission] = useState<MicPermission>('unknown');
  const [audioState, setAudioState] = useState<AudioState>('silence');
  const [recording, setRecording] = useState(false);
  const [lastSoundAt, setLastSoundAt] = useState<Date | null>(null);
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  const [pendingUploads, setPendingUploads] = useState(0);
  const [needsResume, setNeedsResume] = useState(false);
  const online = useOnline();
  const wake = useWakeLock(intent);

  const frameRef = useRef<DetectorFrame | null>(null);
  const intentRef = useRef(intent);
  intentRef.current = intent;
  const healthRef = useRef(health);
  healthRef.current = health;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const lastNotifyRef = useRef(0);
  const currentEvent = useRef<Promise<string | null> | null>(null);
  const heartbeatFails = useRef(0);

  // ---- engine ----------------------------------------------------------------
  const engineRef = useRef<MonitorEngine | null>(null);
  const playerRef = useRef<NoisePlayer | null>(null);
  if (!playerRef.current) playerRef.current = new NoisePlayer();

  const sendHeartbeat = useCallback(async (detail?: string) => {
    const h = healthRef.current;
    const monitoring = intentRef.current;
    const audioOk = monitoring && h.audioOk;
    const text = detail ?? (monitoring ? (audioOk ? 'listening' : h.reason ?? 'interrupted') : 'not listening');
    try {
      await backend.heartbeat(monitoring, audioOk, text);
      heartbeatFails.current = 0;
      setServerOk(true);
    } catch (e) {
      heartbeatFails.current++;
      if (heartbeatFails.current >= 2) setServerOk(false);
      log.warn('net', 'heartbeat failed', String(e));
    }
  }, [backend]);

  const onClipStart = useCallback((c: ClipStart) => {
    setRecording(true);
    setLastSoundAt(c.startedAt);
    const shouldNotify = Date.now() - lastNotifyRef.current >= settingsRef.current.cooldownS * 1000;
    if (shouldNotify) lastNotifyRef.current = Date.now();
    currentEvent.current = (async () => {
      try {
        const id = await backend.createEvent(c.levelDb, c.aboveFloorDb);
        if (shouldNotify) {
          backend.notify(id)
            .then((r) => log.info('push', 'notify result', r))
            .catch((e) => log.error('push', 'notify failed', String(e)));
        }
        return id;
      } catch (e) {
        log.error('events', 'could not create sound event', String(e));
        return null;
      }
    })();
  }, [backend]);

  const onClipEnd = useCallback((clip: Clip) => {
    setRecording(false);
    const eventPromise = currentEvent.current;
    currentEvent.current = null;
    if (!eventPromise) return;
    setPendingUploads((n) => n + 1);
    (async () => {
      const id = await eventPromise;
      if (!id) return;
      try {
        const wav = encodeWav(clip.samples, clip.sampleRate);
        await backend.saveClip(id, wav, { durationMs: clip.durationMs, peakDb: clip.peakDb, aboveFloorDb: clip.aboveFloorDb });
        log.info('events', `clip saved (${(wav.length / 1024).toFixed(0)} KB${clip.interrupted ? ', interrupted' : ''})`);
      } catch (e) {
        log.error('events', 'clip upload failed', String(e));
        await backend.markFailed(id).catch(() => undefined);
      }
    })().finally(() => setPendingUploads((n) => n - 1));
  }, [backend]);

  if (!engineRef.current) {
    engineRef.current = new MonitorEngine({}, settings.sensitivity);
  }
  // keep callbacks fresh
  useEffect(() => {
    engineRef.current!.setCallbacks({
      onFrame: (f: DetectorFrame) => {
        frameRef.current = f;
        setAudioState((s) => (s === f.state ? s : f.state));
      },
      onHealth: (h: Health) => {
        setHealth(h);
        healthRef.current = h;
        if (intentRef.current) void sendHeartbeat();
      },
      onClipStart,
      onClipEnd,
    });
  }, [onClipStart, onClipEnd, sendHeartbeat]);

  useEffect(() => { engineRef.current!.setSensitivity(settings.sensitivity); }, [settings.sensitivity]);
  useEffect(() => { engineRef.current!.setPostRoll(settings.postRollS); }, [settings.postRollS]);

  // ---- permission state ------------------------------------------------------
  useEffect(() => {
    navigator.permissions?.query({ name: 'microphone' as PermissionName })
      .then((p) => {
        setPermission(p.state as MicPermission);
        p.onchange = () => setPermission(p.state as MicPermission);
      })
      .catch(() => undefined);
  }, []);

  // ---- start / stop ----------------------------------------------------------
  const start = useCallback(async () => {
    setMicError(null);
    try {
      await engineRef.current!.start();
      setIntent(true);
      intentRef.current = true;
      setPermission('granted');
      setNeedsResume(false);
      if (playerRef.current!.playing) engineRef.current!.calibrate(4000);
      // The first audio frame triggers onHealth, which sends the heartbeat.
    } catch (e) {
      const err = (typeof e === 'string' ? e : 'unknown') as MicError;
      setMicError(err);
      if (err === 'denied') setPermission('denied');
      log.error('audio', 'start failed', err);
    }
  }, [sendHeartbeat]);

  const stop = useCallback(() => {
    setIntent(false);
    intentRef.current = false;
    engineRef.current!.stop();
    setNeedsResume(false);
    void sendHeartbeat('not listening');
  }, [sendHeartbeat]);

  // ---- heartbeat ---------------------------------------------------------------
  useEffect(() => {
    void sendHeartbeat();
    const id = window.setInterval(() => void sendHeartbeat(), HEARTBEAT_MS);
    return () => window.clearInterval(id);
  }, [sendHeartbeat]);
  useEffect(() => { if (online) void sendHeartbeat(); }, [online, sendHeartbeat]);

  // ---- background / foreground ------------------------------------------------
  useEffect(() => {
    const onVis = async () => {
      if (document.visibilityState === 'hidden') {
        if (intentRef.current) {
          log.warn('app', 'app hidden while monitoring');
          void sendHeartbeat('App is in the background');
        }
        return;
      }
      if (!intentRef.current) return;
      log.info('app', 'app visible again; checking audio');
      // Give the engine a moment to report frames, then restart if needed.
      setTimeout(async () => {
        if (healthRef.current.audioOk) return;
        try {
          engineRef.current!.stop();
          await engineRef.current!.start();
          log.info('audio', 'auto-resumed after returning to app');
        } catch {
          setNeedsResume(true); // iOS may need a tap before audio can restart
        }
      }, 1500);
    };
    const onHide = () => { if (intentRef.current) void sendHeartbeat('App closed'); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onHide);
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('pagehide', onHide); };
  }, [sendHeartbeat]);

  // ---- white noise -------------------------------------------------------------
  const playNoise = useCallback(async (kind: NoiseKind) => {
    setNoise((n) => ({ ...n, kind }));
    await playerRef.current!.play(kind, noise.volume);
    setNoisePlaying(true);
    engineRef.current!.calibrate(4000);
    log.info('noise', 'playing', kind);
  }, [noise.volume, setNoise]);

  const stopNoise = useCallback(() => {
    playerRef.current!.stop();
    setNoisePlaying(false);
    engineRef.current!.calibrate(3000);
  }, []);

  const calibrateTimer = useRef<number | undefined>(undefined);
  const setNoiseVolume = useCallback((volume: number) => {
    setNoise((n) => ({ ...n, volume }));
    playerRef.current!.setVolume(volume);
    window.clearTimeout(calibrateTimer.current);
    calibrateTimer.current = window.setTimeout(() => engineRef.current!.calibrate(3000), 300);
  }, [setNoise]);

  useEffect(() => () => { engineRef.current?.stop(); playerRef.current?.stop(0); }, []);

  const listening = intent && health.audioOk;

  return {
    settings, setSettings,
    noise, noisePlaying, playNoise, stopNoise, setNoiseVolume,
    intent, listening, health, micError, permission, audioState, recording, lastSoundAt,
    serverOk, online, pendingUploads, needsResume, wake,
    start, stop, frameRef,
  };
}
