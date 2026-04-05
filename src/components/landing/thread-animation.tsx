const paths = [
  { id: "hero-path-1", d: "M -200 200 C 100 0, 500 800, 1000 200 L 2200 200", dur: "120s", delay: "0s" },
  { id: "hero-path-2", d: "M -200 400 C 300 900, 600 -200, 1000 400 L 2200 400", dur: "140s", delay: "2s" },
  { id: "hero-path-3", d: "M -200 600 C 400 100, 600 1100, 1000 600 L 2200 600", dur: "160s", delay: "4s" },
  { id: "hero-path-4", d: "M -200 800 C 200 1300, 500 300, 1000 800 L 2200 800", dur: "180s", delay: "6s" },
  { id: "hero-path-5", d: "M -200 500 C 100 100, 800 1200, 1000 500 L 2200 500", dur: "200s", delay: "8s" }
] as const;

const phrase = "MISINFORMATION • HOAX • PROPAGANDA • UNVERIFIED • RUMOR • INVESTIGATING • FACT-CHECKED • RESOLVED • TRUTH • ";
const longText = phrase.repeat(80);

export function ThreadAnimation() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-0 overflow-hidden bg-transparent">
      <svg className="absolute h-full w-full opacity-70" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="gradient-thread-hero" x1="0" y1="0" x2="1920" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#ea580c" stopOpacity="0.72" />
            <stop offset="35%" stopColor="#f97316" stopOpacity="0.82" />
            <stop offset="70%" stopColor="#fb923c" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#ea580c" stopOpacity="0.72" />
          </linearGradient>
        </defs>

        {paths.map((item) => (
          <g key={item.id}>
            <path id={item.id} d={item.d} fill="none" stroke="rgba(234, 88, 12, 0.08)" strokeWidth="2" />

            <text fill="url(#gradient-thread-hero)" fontSize="16" letterSpacing="0.25em" style={{ fontWeight: 600 }}>
              <textPath href={`#${item.id}`} startOffset="-250%" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                <animate
                  attributeName="startOffset"
                  values="-250%;0%"
                  dur={item.dur}
                  begin={item.delay}
                  repeatCount="indefinite"
                />
                {longText}
              </textPath>
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
