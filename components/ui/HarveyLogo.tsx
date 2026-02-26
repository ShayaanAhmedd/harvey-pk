"use client";

interface Props {
  size?: number;
}

/**
 * HarveyLogo — geometric "HP" monogram mark.
 *
 * SVG paths for H and P rendered with thin strokes on a subtle
 * gradient square. Theme-aware, hover-scales, fades in on mount.
 */
export default function HarveyLogo({ size = 36 }: Props) {
  // Letter canvas is 52% wide, 38% tall of the container
  const svgW = Math.round(size * 0.52);
  const svgH = Math.round(size * 0.38);

  return (
    <div
      style={{ width: size, height: size }}
      className="flex items-center justify-center flex-shrink-0 rounded-xl
        bg-gradient-to-br from-white to-gray-100 dark:from-[#1a1a1a] dark:to-[#0f0f0f]
        border border-gray-200 dark:border-neutral-800
        shadow-sm hover:scale-105 transition-all duration-200 logo-fade-in"
      aria-label="Harvey PK"
    >
      {/*
        Viewbox: 20 × 14
        H occupies x 0–8   (left stem, crossbar, right stem)
        P occupies x 10–19 (stem + closed bowl arc)
      */}
      <svg
        width={svgW}
        height={svgH}
        viewBox="0 0 20 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-gray-900 dark:text-white"
        aria-hidden="true"
      >
        {/* H */}
        <line x1="1"  y1="1"  x2="1"  y2="13" />
        <line x1="1"  y1="7"  x2="7"  y2="7"  />
        <line x1="7"  y1="1"  x2="7"  y2="13" />

        {/* P — stem + closed bowl */}
        <line x1="11" y1="1"  x2="11" y2="13" />
        <path d="M11 1 C11 1 19 1 19 4.5 C19 8 11 8 11 8" />
      </svg>
    </div>
  );
}
