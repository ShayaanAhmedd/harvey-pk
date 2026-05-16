"use client";

// WhatsApp integration panel for the Profile page.
// Polls /api/whatsapp/qr every 2 s while waiting for a QR scan.
// Renders the QR using qrcode.react (install: npm install qrcode.react).

import { useState, useEffect, useRef, useCallback } from "react";
import dynamic from "next/dynamic";

// Dynamic import avoids SSR crash if qrcode.react is not yet installed
const QRCodeSVG = dynamic(
  () => import("qrcode.react").then((m) => m.QRCodeSVG),
  { ssr: false }
);

type PanelStatus = "idle" | "connecting" | "ready" | "disconnecting";

export default function WhatsAppPanel() {
  const [status,  setStatus]  = useState<PanelStatus>("idle");
  const [qr,      setQr]      = useState<string | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const checkQR = useCallback(async () => {
    try {
      const res  = await fetch("/api/whatsapp/qr");
      if (!res.ok) return;
      const data = await res.json() as { ready: boolean; qr: string | null };

      if (data.ready) {
        setStatus("ready");
        setQr(null);
        stopPolling();
      } else if (data.qr) {
        setStatus("connecting");
        setQr(data.qr);
      }
    } catch {
      // network error — keep polling silently
    }
  }, [stopPolling]);

  // Check status on mount (client may already be connected from a previous session)
  useEffect(() => {
    checkQR();
    return stopPolling;
  }, [checkQR, stopPolling]);

  function startPolling() {
    stopPolling();
    pollRef.current = setInterval(checkQR, 2000);
  }

  async function handleConnect() {
    setError(null);
    setStatus("connecting");
    setQr(null);
    try {
      // Trigger lazy initialization — QR event will fire server-side
      await fetch("/api/whatsapp/status");
      // Start polling so we pick up the QR once it arrives
      startPolling();
    } catch {
      setError("Failed to start connection. Please try again.");
      setStatus("idle");
    }
  }

  function handleCancel() {
    stopPolling();
    setStatus("idle");
    setQr(null);
  }

  async function handleDisconnect() {
    setError(null);
    setStatus("disconnecting");
    stopPolling();
    try {
      await fetch("/api/whatsapp/disconnect", { method: "DELETE" });
      setStatus("idle");
      setQr(null);
    } catch {
      setError("Disconnect failed. Please try again.");
      setStatus("ready");
    }
  }

  return (
    <div className="bg-[#111111] rounded-xl border border-neutral-800 overflow-hidden">

      {/* ── Status row ── */}
      <div className="px-6 py-5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${
              status === "ready"        ? "bg-emerald-400"               :
              status === "connecting"   ? "bg-yellow-400 animate-pulse"  :
              status === "disconnecting" ? "bg-neutral-400 animate-pulse" :
              "bg-neutral-600"
            }`}
          />
          <div>
            <p className="text-sm font-medium text-neutral-200">WhatsApp</p>
            <p className="text-xs text-neutral-500 mt-0.5">
              {status === "ready"         ? "Connected — ready to send messages"     :
               status === "connecting"    ? "Waiting for QR scan…"                   :
               status === "disconnecting" ? "Disconnecting…"                         :
               "Not connected"}
            </p>
          </div>
        </div>

        <div className="flex gap-2 flex-shrink-0">
          {status === "idle" && (
            <button
              onClick={handleConnect}
              className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm text-neutral-200 transition-colors"
            >
              Connect
            </button>
          )}
          {status === "connecting" && (
            <button
              onClick={handleCancel}
              className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm text-neutral-400 transition-colors"
            >
              Cancel
            </button>
          )}
          {status === "ready" && (
            <button
              onClick={handleDisconnect}
              className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-red-900/40 text-sm text-red-400 hover:text-red-300 transition-colors"
            >
              Disconnect
            </button>
          )}
        </div>
      </div>

      {/* ── QR loading spinner ── */}
      {status === "connecting" && !qr && (
        <div className="border-t border-neutral-800 px-6 py-8 flex flex-col items-center gap-3">
          <div className="w-5 h-5 border-2 border-neutral-600 border-t-neutral-300 rounded-full animate-spin" />
          <p className="text-xs text-neutral-500">Generating QR code…</p>
        </div>
      )}

      {/* ── QR code ── */}
      {status === "connecting" && qr && (
        <div className="border-t border-neutral-800 px-6 py-6 flex flex-col items-center gap-4">
          <p className="text-xs text-neutral-400 text-center leading-relaxed">
            Open <span className="text-neutral-200">WhatsApp</span> on your phone →{" "}
            <span className="text-neutral-200">Linked Devices</span> →{" "}
            <span className="text-neutral-200">Link a Device</span> → scan this QR
          </p>
          <div className="p-4 bg-white rounded-xl shadow-lg">
            <QRCodeSVG value={qr} size={200} />
          </div>
          <p className="text-xs text-neutral-600 text-center">
            QR refreshes automatically every 20 s · Session saved after scan
          </p>
        </div>
      )}

      {/* ── Connected info ── */}
      {status === "ready" && (
        <div className="border-t border-neutral-800 px-6 py-4">
          <p className="text-xs text-neutral-500 leading-relaxed">
            Harvey can send WhatsApp messages to clients directly from chat.
            Try: <span className="text-neutral-300 italic">&ldquo;Send George a WhatsApp about the Monday hearing&rdquo;</span>
          </p>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="border-t border-neutral-800 px-6 py-3">
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}
    </div>
  );
}
