"use client";

import { useEffect, useRef } from "react";

export default function CursorGlow() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let cx = -400, cy = -400;
    let tx = -400, ty = -400;
    let raf = 0;

    function lerp(a: number, b: number, t: number) {
      return a + (b - a) * t;
    }

    function tick() {
      cx = lerp(cx, tx, 0.12);
      cy = lerp(cy, ty, 0.12);
      el!.style.transform = `translate(${cx - 190}px, ${cy - 190}px)`;
      raf = requestAnimationFrame(tick);
    }

    function onMove(e: MouseEvent) {
      tx = e.clientX;
      ty = e.clientY;
    }

    window.addEventListener("mousemove", onMove, { passive: true });
    raf = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  return <div ref={ref} className="cursor-glow" aria-hidden="true" />;
}
