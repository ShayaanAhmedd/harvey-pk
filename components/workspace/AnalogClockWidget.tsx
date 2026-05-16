"use client";

import { useState, useEffect } from "react";
import type { ClockPosition } from "./ClockWidget";
import { playClockTick } from "@/lib/sounds";

export type ClockSize = "sm" | "md" | "lg";

const SIZE_PX: Record<ClockSize, number> = { sm: 88, md: 140, lg: 200 };
const FULLSCREEN_PX = 380;

const POSITION_CLASSES: Record<ClockPosition, string> = {
  "top-right":    "top-4 right-4",
  "top-left":     "top-4 left-[72px]",
  "bottom-right": "bottom-[80px] right-4",
  "bottom-left":  "bottom-[80px] left-[72px]",
};

// Roman numerals for 12 hour positions
const ROMAN = ["XII","I","II","III","IV","V","VI","VII","VIII","IX","X","XI"] as const;

interface ClockFaceProps {
  hourDeg:  number;
  minDeg:   number;
  secDeg:   number;
  px:       number;
  timeStr?: string;
}

function ClockFace({ hourDeg, minDeg, secDeg, px, timeStr }: ClockFaceProps) {
  const cx = 50, cy = 50;
  const OR = 47;   // outer ring radius
  const FR = 44;   // face radius

  return (
    <svg
      viewBox="0 0 100 100"
      width={px}
      height={px}
      style={{ overflow: "visible", filter: "drop-shadow(0 4px 18px rgba(0,0,0,0.45))" }}
      aria-hidden="true"
    >
      {/* ── Outer bezel ── */}
      <circle cx={cx} cy={cy} r={OR}
        fill="rgba(0,0,0,0)"
        stroke="rgba(255,255,255,0.22)"
        strokeWidth="0.6"
      />
      <circle cx={cx} cy={cy} r={OR - 1.2}
        fill="rgba(0,0,0,0)"
        stroke="rgba(255,255,255,0.08)"
        strokeWidth="0.4"
      />

      {/* ── Face fill (dark for readability on any bg) ── */}
      <circle cx={cx} cy={cy} r={FR}
        fill="rgba(4,4,14,0.72)"
        stroke="rgba(255,255,255,0.12)"
        strokeWidth="0.5"
      />

      {/* ── Minute ticks ── */}
      {Array.from({ length: 60 }, (_, i) => {
        if (i % 5 === 0) return null;
        const a = ((i * 6) - 90) * (Math.PI / 180);
        const r1 = FR - 2.5, r2 = FR - 4.5;
        return (
          <line key={i}
            x1={cx + r1 * Math.cos(a)} y1={cy + r1 * Math.sin(a)}
            x2={cx + r2 * Math.cos(a)} y2={cy + r2 * Math.sin(a)}
            stroke="rgba(255,255,255,0.28)" strokeWidth="0.45" strokeLinecap="round"
          />
        );
      })}

      {/* ── Hour ticks ── */}
      {Array.from({ length: 12 }, (_, i) => {
        const a = ((i * 30) - 90) * (Math.PI / 180);
        const r1 = FR - 2, r2 = FR - 6.5;
        return (
          <line key={i}
            x1={cx + r1 * Math.cos(a)} y1={cy + r1 * Math.sin(a)}
            x2={cx + r2 * Math.cos(a)} y2={cy + r2 * Math.sin(a)}
            stroke="rgba(255,255,255,0.75)" strokeWidth="1.1" strokeLinecap="round"
          />
        );
      })}

      {/* ── Roman numerals ── */}
      {ROMAN.map((num, i) => {
        const a = ((i * 30) - 90) * (Math.PI / 180);
        const nr = FR - 13;
        const isQuarter = i % 3 === 0;
        return (
          <text key={num}
            x={cx + nr * Math.cos(a)}
            y={cy + nr * Math.sin(a)}
            textAnchor="middle"
            dominantBaseline="central"
            fill={isQuarter ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.62)"}
            fontSize={isQuarter ? "5.8" : "4.8"}
            fontFamily="Georgia, 'Times New Roman', serif"
            fontWeight={isQuarter ? "600" : "400"}
          >
            {num}
          </text>
        );
      })}

      {/* ── Optional digital readout ── */}
      {timeStr && (
        <text
          x={cx} y={cy + 20}
          textAnchor="middle"
          dominantBaseline="central"
          fill="rgba(255,255,255,0.55)"
          fontSize="4.2"
          fontFamily="'SF Mono', 'Courier New', monospace"
          letterSpacing="0.5"
        >
          {timeStr}
        </text>
      )}

      {/* ── Hour hand (thick, short) ── */}
      <line
        x1={cx - 5 * Math.sin(hourDeg * Math.PI / 180)}
        y1={cy + 5 * Math.cos(hourDeg * Math.PI / 180)}
        x2={cx + 24 * Math.sin(hourDeg * Math.PI / 180)}
        y2={cy - 24 * Math.cos(hourDeg * Math.PI / 180)}
        stroke="rgba(255,255,255,0.95)"
        strokeWidth="2.6"
        strokeLinecap="round"
      />

      {/* ── Minute hand (thin, long) ── */}
      <line
        x1={cx - 6 * Math.sin(minDeg * Math.PI / 180)}
        y1={cy + 6 * Math.cos(minDeg * Math.PI / 180)}
        x2={cx + 34 * Math.sin(minDeg * Math.PI / 180)}
        y2={cy - 34 * Math.cos(minDeg * Math.PI / 180)}
        stroke="rgba(255,255,255,0.88)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />

      {/* ── Second hand with counterbalance tail ── */}
      <line
        x1={cx + 9 * Math.sin((secDeg + 180) * Math.PI / 180)}
        y1={cy - 9 * Math.cos((secDeg + 180) * Math.PI / 180)}
        x2={cx + 37 * Math.sin(secDeg * Math.PI / 180)}
        y2={cy - 37 * Math.cos(secDeg * Math.PI / 180)}
        stroke="var(--accent, #6366f1)"
        strokeWidth="0.75"
        strokeLinecap="round"
      />

      {/* ── Center jewel ── */}
      <circle cx={cx} cy={cy} r="2.4" fill="rgba(255,255,255,0.9)" />
      <circle cx={cx} cy={cy} r="1.2" fill="var(--accent, #6366f1)" />
    </svg>
  );
}

interface Props {
  position: ClockPosition;
  size?:    ClockSize;
}

export default function AnalogClockWidget({ position, size = "md" }: Props) {
  const [time, setTime] = useState<Date>(() => new Date());
  const [fullscreen, setFullscreen] = useState(false);
  const prevSecRef = useState(-1);

  useEffect(() => {
    const id = setInterval(() => {
      setTime((prev) => {
        const next = new Date();
        // Tick sound on second change
        if (next.getSeconds() !== prev.getSeconds()) {
          playClockTick();
        }
        return next;
      });
    }, 250); // 250ms for smooth second-hand
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  // Smooth continuous angles
  const totalSecs = time.getHours() * 3600 + time.getMinutes() * 60 + time.getSeconds();
  const secDeg  = time.getSeconds() * 6;
  const minDeg  = time.getMinutes() * 6 + time.getSeconds() * 0.1;
  const hourDeg = (totalSecs / 120) % 360; // smooth 12h sweep

  const pad = (n: number) => String(n).padStart(2, "0");
  const timeStr = `${pad(time.getHours())}:${pad(time.getMinutes())}`;

  void prevSecRef; // suppress unused warning

  if (fullscreen) {
    return (
      <div
        className="fixed inset-0 z-[200] flex flex-col items-center justify-center"
        style={{ background: "rgba(4,4,14,0.97)", backdropFilter: "blur(28px)", WebkitBackdropFilter: "blur(28px)" }}
      >
        <button
          onClick={() => setFullscreen(false)}
          className="absolute top-6 right-6 text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 rounded-lg border transition-opacity hover:opacity-80"
          style={{ color: "rgba(255,255,255,0.25)", borderColor: "rgba(255,255,255,0.08)" }}
        >
          ESC
        </button>

        <ClockFace hourDeg={hourDeg} minDeg={minDeg} secDeg={secDeg} px={FULLSCREEN_PX} />

        <p
          className="mt-10 text-4xl font-light tabular-nums tracking-[0.25em]"
          style={{ color: "rgba(255,255,255,0.65)", fontFamily: "Georgia, serif" }}
        >
          {pad(time.getHours())}:{pad(time.getMinutes())}:{pad(time.getSeconds())}
        </p>
        <p
          className="mt-2 text-[10px] uppercase tracking-[0.3em]"
          style={{ color: "rgba(255,255,255,0.2)" }}
        >
          {time.toLocaleDateString("en-PK", { weekday: "long", day: "numeric", month: "long" })}
        </p>
      </div>
    );
  }

  const px = SIZE_PX[size];

  return (
    <div
      className={`fixed z-40 pointer-events-auto select-none ${POSITION_CLASSES[position]} scale-in`}
      aria-label={`Analog clock showing ${timeStr}`}
    >
      <button
        onClick={() => setFullscreen(true)}
        title="Expand clock"
        className="block transition-opacity duration-200 hover:opacity-80 active:opacity-60"
      >
        <ClockFace
          hourDeg={hourDeg}
          minDeg={minDeg}
          secDeg={secDeg}
          px={px}
          timeStr={size !== "sm" ? timeStr : undefined}
        />
      </button>
    </div>
  );
}
