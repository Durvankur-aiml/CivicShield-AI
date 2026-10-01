export function ShieldMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden focusable="false">
      <defs>
        <linearGradient id="csg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3B82F6" />
          <stop offset="1" stopColor="#1D4ED8" />
        </linearGradient>
      </defs>
      <path d="M32 4 L54 12 V30 C54 44 45 54 32 60 C19 54 10 44 10 30 V12 Z" fill="url(#csg)" stroke="#93C5FD" strokeWidth="2" />
      <path d="M22 31 L29 38 L43 24" fill="none" stroke="#F8FAFC" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <span className="flex items-center gap-2.5">
      <ShieldMark size={size} />
      <span className="text-[15px] font-semibold tracking-tight text-cs-text">
        CivicShield <span className="text-blue-400">AI</span>
      </span>
    </span>
  );
}
