"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { playClockTick } from "@/lib/sounds";

export type ClockPosition = "top-right" | "top-left" | "bottom-right" | "bottom-left";
type ClockMode = "clock" | "stopwatch" | "timer";

interface Props {
  position: ClockPosition;
}

const POSITION_CLASSES: Record<ClockPosition, string> = {
  "top-right":    "top-4 right-4",
  "top-left":     "top-4 left-[72px]",
  "bottom-right": "bottom-[80px] right-4",
  "bottom-left":  "bottom-[80px] left-[72px]",
};

// ── Single flip digit ─────────────────────────────────────────────────────────
function FlipDigit({ value, prev }: { value: string; prev: string }) {
  const [flipping, setFlipping] = useState(false);
  useEffect(() => {
    if (value !== prev) {
      setFlipping(true);
      playClockTick();
      const t = setTimeout(() => setFlipping(false), 300);
      return () => clearTimeout(t);
    }
  }, [value, prev]);
  return (
    <div
      className={`relative w-6 h-8 flex items-center justify-center rounded-md overflow-hidden select-none ${flipping ? "digit-flip" : ""}`}
      style={{ background: "rgba(0,0,0,0.35)" }}
    >
      <div className="absolute inset-x-0 top-0 h-1/2 overflow-hidden flex items-end justify-center pb-px">
        <span className="text-sm font-bold tabular-nums leading-none" style={{ color: "var(--accent,#6366f1)" }}>{value}</span>
      </div>
      <div className="absolute inset-x-0 top-1/2 h-px bg-black/30" />
      <div className="absolute inset-x-0 bottom-0 h-1/2 overflow-hidden flex items-start justify-center pt-px">
        <span className="text-sm font-bold tabular-nums leading-none" style={{ color: "var(--accent,#6366f1)" }}>{value}</span>
      </div>
    </div>
  );
}

function DigitPair({ value, prev }: { value: string; prev: string }) {
  return (
    <div className="flex gap-0.5">
      <FlipDigit value={value[0]} prev={prev[0]} />
      <FlipDigit value={value[1]} prev={prev[1]} />
    </div>
  );
}

function Sep({ large }: { large?: boolean }) {
  return (
    <span className={`font-bold pb-0.5 ${large ? "text-4xl" : "text-xs"}`} style={{ color: "var(--accent,#6366f1)", opacity: 0.6 }}>:</span>
  );
}

// ── Large digit block (fullscreen) ────────────────────────────────────────────
function LargeBlock({ value }: { value: string }) {
  return (
    <div className="flex gap-2">
      {value.split("").map((ch, i) => (
        <div key={i} className="w-16 h-24 rounded-2xl flex items-center justify-center" style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)" }}>
          <span className="text-6xl font-black tabular-nums" style={{ color: "var(--accent,#6366f1)" }}>{ch}</span>
        </div>
      ))}
    </div>
  );
}

// ── Clock Widget ──────────────────────────────────────────────────────────────
export default function ClockWidget({ position }: Props) {
  const pad = (n: number) => String(n).padStart(2, "0");

  // Current clock time
  const nowTime = () => { const d = new Date(); return { h: pad(d.getHours()), m: pad(d.getMinutes()), s: pad(d.getSeconds()) }; };
  const [time,     setTime]     = useState(nowTime);
  const [prevTime, setPrevTime] = useState(nowTime);

  useEffect(() => {
    const id = setInterval(() => { setTime(p => { setPrevTime(p); return nowTime(); }); }, 1000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mode + running state
  const [mode,    setMode]    = useState<ClockMode>("clock");
  const [running, setRunning] = useState(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clearTick = () => { if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; } };

  // Stopwatch
  const [elapsed, setElapsed] = useState(0); // ms

  // Timer
  const [timerTotal,     setTimerTotal]     = useState(5 * 60); // seconds
  const [timerRemaining, setTimerRemaining] = useState(5 * 60);

  const startStopwatch = useCallback(() => {
    clearTick();
    const start = Date.now() - elapsed;
    tickRef.current = setInterval(() => setElapsed(Date.now() - start), 100);
    setRunning(true);
  }, [elapsed]);

  const startTimer = useCallback(() => {
    clearTick();
    const end = Date.now() + timerRemaining * 1000;
    tickRef.current = setInterval(() => {
      const left = Math.max(0, Math.round((end - Date.now()) / 1000));
      setTimerRemaining(left);
      if (left === 0) { clearTick(); setRunning(false); }
    }, 200);
    setRunning(true);
  }, [timerRemaining]);

  const stop  = () => { clearTick(); setRunning(false); };
  const reset = useCallback(() => {
    clearTick();
    setRunning(false);
    if (mode === "stopwatch") setElapsed(0);
    if (mode === "timer") setTimerRemaining(timerTotal);
  }, [mode, timerTotal]);

  const switchMode = (m: ClockMode) => { clearTick(); setRunning(false); setElapsed(0); setTimerRemaining(timerTotal); setMode(m); };

  useEffect(() => () => clearTick(), []);

  // Stopwatch display values
  const swTotal = Math.floor(elapsed / 1000);
  const swH = pad(Math.floor(swTotal / 3600));
  const swM = pad(Math.floor((swTotal % 3600) / 60));
  const swS = pad(swTotal % 60);

  // Timer display values
  const tmH = pad(Math.floor(timerRemaining / 3600));
  const tmM = pad(Math.floor((timerRemaining % 3600) / 60));
  const tmS = pad(timerRemaining % 60);

  // Fullscreen
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  // ── Sub-components ────────────────────────────────────────
  function ModeTabs({ large }: { large?: boolean }) {
    return (
      <div className={`flex gap-1 ${large ? "mb-10" : "mt-1.5"}`}>
        {(["clock", "stopwatch", "timer"] as ClockMode[]).map(m => (
          <button
            key={m}
            onClick={() => switchMode(m)}
            className={`font-bold uppercase tracking-wide transition-all duration-150 ${large ? "px-4 py-1.5 text-xs rounded-xl" : "px-2 py-0.5 text-[9px] rounded-md"}`}
            style={{
              background: mode === m ? "rgba(var(--accent-rgb,79,70,229),0.7)" : "rgba(255,255,255,0.06)",
              color: mode === m ? "#fff" : "rgba(255,255,255,0.4)",
            }}
          >
            {large ? (m === "stopwatch" ? "Stopwatch" : m.charAt(0).toUpperCase() + m.slice(1)) : (m === "stopwatch" ? "SW" : m === "clock" ? "CK" : "TM")}
          </button>
        ))}
      </div>
    );
  }

  function PlayControls({ large }: { large?: boolean }) {
    if (mode === "clock") return null;
    const base = `font-bold uppercase tracking-wide transition-all duration-150 ${large ? "px-6 py-2.5 text-sm rounded-xl" : "px-2.5 py-1 text-[10px] rounded-lg"}`;
    return (
      <div className={`flex gap-2 ${large ? "mt-6" : "mt-1.5"}`}>
        <button
          onClick={() => running ? stop() : (mode === "stopwatch" ? startStopwatch() : startTimer())}
          className={base}
          style={{ background: running ? "rgba(239,68,68,0.65)" : "rgba(var(--accent-rgb,79,70,229),0.65)", color: "#fff" }}
        >
          {running ? "Pause" : "Start"}
        </button>
        <button
          onClick={reset}
          className={base}
          style={{ color: "var(--accent,#6366f1)", border: "1px solid rgba(var(--accent-rgb,79,70,229),0.3)", background: "rgba(var(--accent-rgb,79,70,229),0.08)" }}
        >
          Reset
        </button>
        {mode === "timer" && !running && (
          <button
            onClick={() => setTimerTotal(t => { const n = t + 60; setTimerRemaining(n); return n; })}
            className={base}
            style={{ color: "rgba(255,255,255,0.4)", background: "rgba(255,255,255,0.05)" }}
            title="+1 min"
          >
            +1m
          </button>
        )}
      </div>
    );
  }

  // ── Fullscreen overlay ────────────────────────────────────
  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center" style={{ background: "rgba(4,4,14,0.97)", backdropFilter: "blur(28px)" }}>
        <button
          onClick={() => setFullscreen(false)}
          className="absolute top-6 right-6 text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 rounded-lg border transition-opacity hover:opacity-80"
          style={{ color: "rgba(255,255,255,0.25)", borderColor: "rgba(255,255,255,0.08)" }}
        >
          ESC
        </button>

        <p className="text-[10px] font-black uppercase tracking-[0.35em] mb-8" style={{ color: "rgba(255,255,255,0.25)" }}>
          {mode}
        </p>

        <ModeTabs large />

        <div className="flex items-center gap-4">
          {mode === "clock" && (
            <>
              <LargeBlock value={time.h} />
              <Sep large />
              <LargeBlock value={time.m} />
              <Sep large />
              <LargeBlock value={time.s} />
            </>
          )}
          {mode === "stopwatch" && (
            <>
              <LargeBlock value={swH} />
              <Sep large />
              <LargeBlock value={swM} />
              <Sep large />
              <LargeBlock value={swS} />
            </>
          )}
          {mode === "timer" && (
            <>
              <LargeBlock value={tmH} />
              <Sep large />
              <LargeBlock value={tmM} />
              <Sep large />
              <LargeBlock value={tmS} />
            </>
          )}
        </div>

        <PlayControls large />
      </div>
    );
  }

  // ── Corner widget ─────────────────────────────────────────
  return (
    <div className={`fixed z-40 pointer-events-auto select-none ${POSITION_CLASSES[position]} scale-in`} aria-label={mode}>
      <div
        className="flex flex-col px-2.5 py-2 rounded-xl shadow-lg"
        style={{ background: "rgba(0,0,0,0.42)", backdropFilter: "blur(20px) saturate(1.4)", WebkitBackdropFilter: "blur(20px) saturate(1.4)", border: "1px solid rgba(255,255,255,0.09)", boxShadow: "0 8px 32px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.05)" }}
      >
        {/* Digit row + fullscreen button */}
        <div className="flex items-center gap-1">
          {mode === "clock" && (
            <>
              <DigitPair value={time.h} prev={prevTime.h} />
              <Sep /><DigitPair value={time.m} prev={prevTime.m} />
              <Sep /><DigitPair value={time.s} prev={prevTime.s} />
            </>
          )}
          {mode === "stopwatch" && (
            <>
              <DigitPair value={swH} prev={swH} />
              <Sep /><DigitPair value={swM} prev={swM} />
              <Sep /><DigitPair value={swS} prev={swS} />
            </>
          )}
          {mode === "timer" && (
            <>
              <DigitPair value={tmH} prev={tmH} />
              <Sep /><DigitPair value={tmM} prev={tmM} />
              <Sep /><DigitPair value={tmS} prev={tmS} />
            </>
          )}
          <button onClick={() => setFullscreen(true)} title="Fullscreen" className="ml-1 opacity-35 hover:opacity-80 transition-opacity" style={{ color: "var(--accent,#6366f1)" }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
              <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
            </svg>
          </button>
        </div>

        <ModeTabs />
        <PlayControls />
      </div>
    </div>
  );
}
