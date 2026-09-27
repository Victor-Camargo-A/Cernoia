import { cn } from "@/lib/utils";

export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn("brand-mark", className)} aria-hidden="true">
      <svg viewBox="0 0 48 48" fill="none">
        <path d="M31.8 12.1A15.5 15.5 0 1 0 32 35.8" stroke="currentColor" strokeWidth="4.6" strokeLinecap="round" />
        <path d="M35 15.4a12 12 0 0 1 0 17.2" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" opacity=".56" />
        <circle cx="36.5" cy="11" r="3.7" fill="currentColor" />
        <path d="M15 24h13" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" opacity=".72" />
      </svg>
    </span>
  );
}

export function BrandLockup({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <BrandMark className="size-10 shrink-0" />
      {!compact && (
        <div className="min-w-0">
          <p className="brand-wordmark text-[1.05rem] font-semibold tracking-[-0.02em]">Cerno<span>IA</span></p>
          <p className="truncate text-[10px] font-medium uppercase tracking-[0.18em] opacity-55">Inteligencia de mercados públicos</p>
        </div>
      )}
    </div>
  );
}
