import { useEffect, type ReactNode, type ButtonHTMLAttributes } from 'react';

type Tone = 'primary' | 'quiet' | 'danger';

export function Button({ tone = 'primary', className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone }) {
  const tones: Record<Tone, string> = {
    primary: 'bg-ink text-bg active:opacity-80',
    quiet: 'bg-raised/70 text-ink active:bg-raised',
    danger: 'bg-raised/70 text-coral active:bg-raised',
  };
  return (
    <button
      {...p}
      className={`min-h-14 w-full rounded-full px-6 text-[17px] font-medium transition disabled:opacity-40 ${tones[tone]} ${className}`}
    />
  );
}

export function Dot({ color, pulse = false }: { color: 'sage' | 'heather' | 'amber' | 'coral' | 'faint'; pulse?: boolean }) {
  const c = { sage: 'bg-sage', heather: 'bg-heather', amber: 'bg-amber', coral: 'bg-coral', faint: 'bg-faint' }[color];
  return <span aria-hidden className={`inline-block size-2.5 shrink-0 rounded-full ${c} ${pulse ? 'pulse-dot' : ''}`} />;
}

export function Slider({ label, value, onChange, hint, min = 0, max = 1, step = 0.01 }: {
  label: string; value: number; onChange: (v: number) => void; hint?: ReactNode; min?: number; max?: number; step?: number;
}) {
  const fill = `${((value - min) / (max - min)) * 100}%`;
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-[15px]">
        <span>{label}</span>
        {hint && <span className="text-mist">{hint}</span>}
      </span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        style={{ ['--fill' as string]: fill }}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
      />
    </label>
  );
}

export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: { id: T; label: string }[]; value: T | null; onChange: (v: T) => void; label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-2 gap-2">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id} role="radio" aria-checked={on} onClick={() => onChange(o.id)}
            className={`min-h-12 rounded-2xl px-4 text-left text-[15px] transition ${on ? 'bg-ink text-bg' : 'bg-raised/60 text-ink active:bg-raised'}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Choice<T extends string | number>({ options, value, onChange, label }: {
  options: { id: T; label: string }[]; value: T; onChange: (v: T) => void; label: string;
}) {
  return (
    <div>
      <div className="mb-2 text-[15px]">{label}</div>
      <div role="radiogroup" aria-label={label} className="flex gap-1 rounded-full bg-raised/60 p-1">
        {options.map((o) => (
          <button
            key={String(o.id)} role="radio" aria-checked={o.id === value} onClick={() => onChange(o.id)}
            className={`min-h-10 flex-1 rounded-full text-[14px] transition ${o.id === value ? 'bg-ink text-bg' : 'text-mist'}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Toggle({ label, checked, onChange, description, disabled }: {
  label: string; checked: boolean; onChange: (v: boolean) => void; description?: ReactNode; disabled?: boolean;
}) {
  return (
    <button
      role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
      className="flex min-h-14 w-full items-center justify-between gap-4 text-left disabled:opacity-40"
    >
      <span>
        <span className="block text-[16px]">{label}</span>
        {description && <span className="mt-0.5 block text-[14px] text-mist">{description}</span>}
      </span>
      <span className={`relative h-8 w-13 shrink-0 rounded-full transition ${checked ? 'bg-sage' : 'bg-raised'}`}>
        <span className={`absolute top-1 size-6 rounded-full bg-ink shadow transition-all ${checked ? 'left-6 bg-on-accent' : 'left-1'}`} />
      </span>
    </button>
  );
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-[28px] bg-surface p-5 ${className}`}>{children}</section>;
}

export function Notice({ tone, title, children, action }: {
  tone: 'amber' | 'coral' | 'mist'; title: string; children?: ReactNode; action?: ReactNode;
}) {
  const ring = tone === 'coral' ? 'border-coral/60' : tone === 'amber' ? 'border-amber/50' : 'border-line';
  const head = tone === 'coral' ? 'text-coral' : tone === 'amber' ? 'text-amber' : 'text-ink';
  return (
    <div role={tone === 'coral' ? 'alert' : 'status'} className={`rounded-3xl border ${ring} p-4`}>
      <div className={`text-[16px] font-medium ${head}`}>{title}</div>
      {children && <div className="mt-1 text-[14px] leading-relaxed text-mist">{children}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end" role="dialog" aria-modal aria-label={title}>
      <button aria-label="Close" className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="sheet relative max-h-[88dvh] overflow-y-auto rounded-t-[32px] bg-surface px-5 pt-3 pb-[max(env(safe-area-inset-bottom),24px)]">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-line" />
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-[22px] font-light">{title}</h2>
          <button onClick={onClose} className="min-h-11 rounded-full px-4 text-[15px] text-mist active:bg-raised">Done</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button aria-label={label} onClick={onClick} className="grid size-11 place-items-center rounded-full text-mist active:bg-surface">
      {children}
    </button>
  );
}

export const GearIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" />
  </svg>
);
export const PlayIcon = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9-5.5z" /></svg>;
export const PauseIcon = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" /></svg>;
