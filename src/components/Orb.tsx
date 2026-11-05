// The Baby Unit's listening orb: rings swell with the room's level; the faint outer ring is
// the detection threshold. Drawn on canvas from a ref so it never re-renders React.
import { useEffect, useRef } from 'react';
import type { DetectorFrame } from '../audio/monitor';

const DB_MIN = -80;
const DB_MAX = -10;
const norm = (db: number) => Math.max(0, Math.min(1, (db - DB_MIN) / (DB_MAX - DB_MIN)));

export function Orb({ frameRef, live, hot }: { frameRef: React.MutableRefObject<DetectorFrame | null>; live: boolean; hot: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef(live);
  const hotRef = useRef(hot);
  liveRef.current = live;
  hotRef.current = hot;

  useEffect(() => {
    const c = canvas.current!;
    const g = c.getContext('2d')!;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let level = 0;
    let threshold = 0.5;
    let t = 0;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const size = c.clientWidth;
      if (size < 40) { raf = requestAnimationFrame(draw); return; }
      if (c.width !== size * dpr) { c.width = size * dpr; c.height = size * dpr; }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, size, size);
      const css = getComputedStyle(document.documentElement);
      const sage = css.getPropertyValue('--sage').trim();
      const heather = css.getPropertyValue('--heather').trim();
      const faint = css.getPropertyValue('--faint').trim();

      const f = frameRef.current;
      const target = liveRef.current && f ? norm(f.levelDb) : 0;
      level += (target - level) * (target > level ? 0.35 : 0.08);
      if (f) threshold += (norm(f.thresholdDb) - threshold) * 0.05;
      t += 1 / 60;

      const cx = size / 2;
      const rMax = size / 2 - 4;
      const rMin = rMax * 0.34;
      const color = liveRef.current ? (hotRef.current ? heather : sage) : faint;

      // threshold ring
      if (liveRef.current) {
        g.beginPath();
        g.arc(cx, cx, rMin + (rMax - rMin) * threshold, 0, Math.PI * 2);
        g.strokeStyle = faint;
        g.globalAlpha = 0.45;
        g.lineWidth = 1;
        g.setLineDash([2, 6]);
        g.stroke();
        g.setLineDash([]);
      }

      // soft level rings
      const breathe = reduce || !liveRef.current ? 0 : Math.sin(t * 1.1) * 0.015;
      for (let i = 3; i >= 0; i--) {
        const k = i / 3;
        const r = rMin + (rMax - rMin) * Math.max(0, level - k * 0.12) + rMax * breathe;
        g.beginPath();
        g.arc(cx, cx, Math.max(rMin * 0.6, r * (1 - k * 0.08)), 0, Math.PI * 2);
        g.fillStyle = color;
        g.globalAlpha = 0.06 + (1 - k) * 0.1;
        g.fill();
      }
      // core
      g.beginPath();
      g.arc(cx, cx, rMin * (0.9 + level * 0.25), 0, Math.PI * 2);
      g.globalAlpha = liveRef.current ? 0.9 : 0.35;
      g.fillStyle = color;
      g.fill();
      g.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [frameRef]);

  return <canvas ref={canvas} aria-hidden className="aspect-square w-full max-w-[300px]" />;
}
