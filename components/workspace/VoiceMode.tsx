"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { parseUICommands, executeUICommand } from "@/lib/ui-actions";

// ── Types ─────────────────────────────────────────────────────────────────────

type VoiceStatus = "connecting" | "listening" | "thinking" | "speaking" | "error";

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  time: string;
}

// ── Audio helpers ─────────────────────────────────────────────────────────────

function floatToPcm16(float32: Float32Array): Int16Array {
  const pcm16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const c = Math.max(-1, Math.min(1, float32[i]));
    pcm16[i] = c < 0 ? c * 32768 : c * 32767;
  }
  return pcm16;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── Status config ─────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<VoiceStatus, string> = {
  connecting: "Connecting…",
  listening:  "Listening…",
  thinking:   "Thinking…",
  speaking:   "Speaking…",
  error:      "Connection error",
};

// Accent-aware colors for each state
const STATUS_COLOR: Record<VoiceStatus, string> = {
  connecting: "rgba(107,107,255,0.45)",
  listening:  "rgba(107,107,255,1)",
  thinking:   "rgba(251,191,36,0.95)",
  speaking:   "rgba(52,211,153,0.95)",
  error:      "rgba(239,68,68,0.85)",
};

const STATUS_GLOW: Record<VoiceStatus, string> = {
  connecting: "rgba(107,107,255,0.12)",
  listening:  "rgba(107,107,255,0.22)",
  thinking:   "rgba(251,191,36,0.18)",
  speaking:   "rgba(52,211,153,0.22)",
  error:      "rgba(239,68,68,0.18)",
};

// ── VoiceOrb — animated ring set ──────────────────────────────────────────────

function VoiceOrb({ status }: { status: VoiceStatus }) {
  const color = STATUS_COLOR[status];
  const glow  = STATUS_GLOW[status];

  const speed =
    status === "speaking"   ? "0.75s" :
    status === "thinking"   ? "1.1s"  :
    status === "listening"  ? "2.2s"  : "3s";

  const ringStyle = (size: number, delay: string, opacity: number): React.CSSProperties => ({
    position: "absolute",
    width: size,
    height: size,
    borderRadius: "50%",
    border: `1px solid ${color}`,
    opacity,
    animation: `voice-ring ${speed} ease-in-out ${delay} infinite`,
  });

  return (
    <div style={{ position: "relative", width: 200, height: 200, display: "flex", alignItems: "center", justifyContent: "center" }}>
      {/* Outer rings */}
      <div style={ringStyle(200, "0s",   0.18)} />
      <div style={ringStyle(170, "0.1s", 0.28)} />
      <div style={ringStyle(140, "0.2s", 0.40)} />

      {/* Inner filled circle */}
      <div style={{
        width: 104,
        height: 104,
        borderRadius: "50%",
        background: `radial-gradient(circle at 40% 35%, ${glow.replace(/[\d.]+\)$/, "0.9)")}, ${glow})`,
        border: `1.5px solid ${color}`,
        boxShadow: `0 0 48px ${glow}, 0 0 20px ${glow}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "all 0.5s ease",
      }}>
        {/* Shield icon */}
        <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5"
          strokeLinecap="round" strokeLinejoin="round"
          style={{ width: 38, height: 38, opacity: 0.9 }}
        >
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  onClose: (transcript: TranscriptEntry[]) => void;
}

// ── Voice persona map ─────────────────────────────────────────────────────────

type VoicePersona = "alloy" | "shimmer" | "echo" | "coral" | "verse";

const PERSONA_LABEL: Record<VoicePersona, string> = {
  alloy:   "Young Male",
  shimmer: "Young Female",
  echo:    "Deep Male",
  coral:   "Soft Female",
  verse:   "Neutral AI",
};

function loadVoicePersona(): VoicePersona {
  try {
    const saved = JSON.parse(localStorage.getItem("harvey_appearance") ?? "{}") as Record<string, unknown>;
    const v = saved.voicePersona as string | undefined;
    if (v && v in PERSONA_LABEL) return v as VoicePersona;
  } catch {}
  return "alloy";
}

export default function VoiceMode({ onClose }: Props) {
  const [status,   setStatus]   = useState<VoiceStatus>("connecting");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [persona,  setPersona]  = useState<VoicePersona>(() => loadVoicePersona());

  // Refs — stable across renders, no re-render triggered
  const wsRef            = useRef<WebSocket | null>(null);
  const audioCtxRef      = useRef<AudioContext | null>(null);
  const micStreamRef     = useRef<MediaStream | null>(null);
  const processorRef     = useRef<ScriptProcessorNode | null>(null);
  const sourceNodeRef    = useRef<MediaStreamAudioSourceNode | null>(null);
  const nextPlayTimeRef  = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const statusRef        = useRef<VoiceStatus>("connecting");
  const isClosingRef     = useRef<boolean>(false);
  const personaRef       = useRef<VoicePersona>(loadVoicePersona());
  const transcriptRef    = useRef<TranscriptEntry[]>([]);

  const updateStatus = useCallback((s: VoiceStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  // Keep ref in sync so WS callbacks always read the latest persona
  useEffect(() => { personaRef.current = persona; }, [persona]);

  // ── Safe AudioContext close ───────────────────────────────────────────────
  const closeAudioContext = useCallback(async () => {
    const ctx = audioCtxRef.current;
    if (!ctx || ctx.state === "closed") return;
    try { await ctx.close(); } catch {}
  }, []);

  // ── Cleanup all resources ─────────────────────────────────────────────────
  const cleanup = useCallback(() => {
    // Guard: prevent double-close
    if (isClosingRef.current) return;
    isClosingRef.current = true;

    try { wsRef.current?.close(); }                                    catch {}
    try { micStreamRef.current?.getTracks().forEach(t => t.stop()); } catch {}
    try { processorRef.current?.disconnect(); }                        catch {}
    try { sourceNodeRef.current?.disconnect(); }                       catch {}

    // Close AudioContext only when not already closed
    closeAudioContext();

    wsRef.current         = null;
    micStreamRef.current  = null;
    processorRef.current  = null;
    sourceNodeRef.current = null;
  }, [closeAudioContext]);

  // ── Stop AI audio (interrupt) — never closes AudioContext ────────────────
  const stopAudioPlayback = useCallback(() => {
    for (const src of activeSourcesRef.current) {
      try { src.stop(); } catch {}
    }
    activeSourcesRef.current = [];
    const ctx = audioCtxRef.current;
    // Only reset play-head when context is still running
    if (ctx && ctx.state !== "closed") {
      nextPlayTimeRef.current = ctx.currentTime;
    }
  }, []);

  // ── Play one PCM16 base64 chunk ───────────────────────────────────────────
  const playChunk = useCallback((base64: string) => {
    const ctx = audioCtxRef.current;
    if (!ctx || !base64 || ctx.state === "closed") return;

    const bytes  = base64ToUint8Array(base64);
    const int16  = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

    const audioBuf = ctx.createBuffer(1, float32.length, 24000);
    audioBuf.getChannelData(0).set(float32);

    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);
    activeSourcesRef.current.push(src);

    const startAt = Math.max(ctx.currentTime, nextPlayTimeRef.current);
    src.start(startAt);
    nextPlayTimeRef.current = startAt + audioBuf.duration;

    src.onended = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== src);
    };
  }, []);

  // ── Handle WebSocket messages ─────────────────────────────────────────────
  const handleMessage = useCallback((raw: string) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type as string) {
      case "session.created":
      case "session.updated":
        updateStatus("listening");
        break;

      case "input_audio_buffer.speech_started":
        // User spoke — interrupt AI immediately
        stopAudioPlayback();
        if (statusRef.current === "speaking") {
          wsRef.current?.send(JSON.stringify({ type: "response.cancel" }));
        }
        updateStatus("listening");
        break;

      case "input_audio_buffer.speech_stopped":
        updateStatus("thinking");
        break;

      case "response.created":
        updateStatus("thinking");
        break;

      case "response.audio.delta": {
        const delta = msg.delta as string | undefined;
        if (delta) { playChunk(delta); updateStatus("speaking"); }
        break;
      }

      case "response.audio_transcript.done": {
        // Assistant speech transcript — execute any UI commands, store clean text
        const raw = (msg.transcript as string | undefined)?.trim();
        if (raw) {
          const { clean, commands } = parseUICommands(raw);
          commands.forEach(executeUICommand);
          const displayText = clean.trim();
          if (displayText) {
            transcriptRef.current.push({ role: "assistant", text: displayText, time: new Date().toLocaleTimeString() });
          }
        }
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        // User speech transcript — append to call log
        const text = (msg.transcript as string | undefined)?.trim();
        if (text) {
          transcriptRef.current.push({ role: "user", text, time: new Date().toLocaleTimeString() });
        }
        break;
      }

      case "response.done":
        // Give a moment for the last audio chunk to finish, then go back to listening
        updateStatus("listening");
        break;

      case "error": {
        const err = msg.error as Record<string, string> | undefined;
        setErrorMsg(err?.message ?? "Voice session error");
        updateStatus("error");
        break;
      }
    }
  }, [updateStatus, stopAudioPlayback, playChunk]);

  // ── Start mic → WebSocket audio pipe ─────────────────────────────────────
  const startMicStream = useCallback((
    stream: MediaStream,
    ctx: AudioContext,
    ws: WebSocket,
  ) => {
    const source    = ctx.createMediaStreamSource(stream);
    // 2048 samples = ~85ms at 24kHz — low latency, manageable chunk size
    const processor = ctx.createScriptProcessor(2048, 1, 1);

    sourceNodeRef.current  = source;
    processorRef.current   = processor;

    processor.onaudioprocess = (e) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const float32 = e.inputBuffer.getChannelData(0);
      const pcm16   = floatToPcm16(float32);
      const base64  = arrayBufferToBase64(pcm16.buffer);
      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64 }));
    };

    source.connect(processor);
    // Connect to destination so the graph runs (output is silent — no echo)
    processor.connect(ctx.destination);
  }, []);

  // ── Bootstrap the session ─────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        // 1. Get ephemeral token from our backend (never exposes OPENAI_API_KEY to browser)
        const tokenRes = await fetch("/api/voice/session", { method: "POST" });
        if (!tokenRes.ok) {
          const err = await tokenRes.json().catch(() => ({})) as Record<string, unknown>;
          throw new Error((err.error as string) ?? "Could not create voice session");
        }
        const sessionData = await tokenRes.json() as {
          client_secret?: { value?: string };
        };
        const token = sessionData?.client_secret?.value;
        if (!token) throw new Error("No ephemeral token received");
        if (cancelled) return;

        // 2. Mic permission
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate:        24000,
            channelCount:      1,
            echoCancellation:  true,
            noiseSuppression:  true,
            autoGainControl:   true,
          },
        });
        micStreamRef.current = stream;
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }

        // 3. AudioContext — close any existing context before creating a new one
        await closeAudioContext();
        const ctx = new AudioContext({ sampleRate: 24000 });
        audioCtxRef.current = ctx;
        isClosingRef.current = false; // reset flag for this new session
        nextPlayTimeRef.current = ctx.currentTime;

        // 4. Open WebSocket to OpenAI Realtime API with ephemeral key
        const ws = new WebSocket(
          "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
          [
            "realtime",
            `openai-insecure-api-key.${token}`,
            "openai-beta.realtime-v1",
          ],
        );
        wsRef.current = ws;

        ws.onopen = () => {
          if (cancelled) { ws.close(); return; }
          // Send session config — UI command instructions synced from lib/ui-actions
          ws.send(JSON.stringify({
            type: "session.update",
            session: {
              modalities:          ["text", "audio"],
              voice:               personaRef.current,
              input_audio_format:  "pcm16",
              output_audio_format: "pcm16",
              input_audio_transcription: { model: "whisper-1" },
              turn_detection: {
                type:                "server_vad",
                threshold:           0.5,
                prefix_padding_ms:   300,
                silence_duration_ms: 600,
              },
            },
          }));
          startMicStream(stream, ctx, ws);
          updateStatus("listening");
        };

        ws.onmessage = (e) => handleMessage(e.data);

        ws.onerror = () => {
          setErrorMsg("WebSocket connection failed");
          updateStatus("error");
        };

        ws.onclose = (e) => {
          if (cancelled || e.wasClean) return;
          setErrorMsg("Connection lost");
          updateStatus("error");
        };

      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Failed to start voice session";
        // Friendly mic permission message
        const friendly = msg.includes("Permission") || msg.includes("NotAllowed")
          ? "Microphone access denied. Please allow mic access and try again."
          : msg;
        setErrorMsg(friendly);
        updateStatus("error");
      }
    }

    boot();
    return () => { cancelled = true; cleanup(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ESC key to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const t = transcriptRef.current;
        cleanup();
        onClose(t);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cleanup, onClose]);

  function handleEndCall() {
    const t = transcriptRef.current;
    cleanup();
    onClose(t);
  }

  const color = STATUS_COLOR[status];

  return (
    <div
      className="fixed inset-0 z-[200] flex flex-col items-center justify-center select-none"
      style={{
        background:              "rgba(4,4,14,0.97)",
        backdropFilter:          "blur(32px)",
        WebkitBackdropFilter:    "blur(32px)",
      }}
    >
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-6 py-5">
        <span
          className="text-[11px] font-black uppercase tracking-[0.3em]"
          style={{ color: "rgba(255,255,255,0.25)" }}
        >
          Harvey PK · Live
        </span>
        <button
          onClick={handleEndCall}
          className="text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 rounded-lg border transition-opacity hover:opacity-80"
          style={{ color: "rgba(255,255,255,0.25)", borderColor: "rgba(255,255,255,0.08)" }}
        >
          ESC
        </button>
      </div>

      {/* Center orb + status */}
      <div className="flex flex-col items-center gap-10">
        <VoiceOrb status={status} />

        <div className="text-center min-h-[40px] flex flex-col items-center justify-center gap-2">
          <p
            className="text-sm font-semibold tracking-wide transition-all duration-300"
            style={{ color: status === "error" ? "rgba(239,68,68,0.9)" : "rgba(255,255,255,0.8)" }}
          >
            {STATUS_LABEL[status]}
          </p>
          {errorMsg && (
            <p
              className="text-xs max-w-xs text-center leading-relaxed"
              style={{ color: "rgba(239,68,68,0.6)" }}
            >
              {errorMsg}
            </p>
          )}
        </div>

        {/* Interrupt hint — only when AI is speaking */}
        {status === "speaking" && (
          <p
            className="text-[10px] uppercase tracking-[0.2em]"
            style={{ color: "rgba(255,255,255,0.18)" }}
          >
            Speak to interrupt
          </p>
        )}
      </div>

      {/* End call button */}
      <div className="absolute bottom-12 flex flex-col items-center gap-2.5">
        <button
          onClick={handleEndCall}
          aria-label="End voice call"
          className="w-14 h-14 rounded-full flex items-center justify-center transition-all duration-200 hover:scale-105 active:scale-95"
          style={{
            background: "rgba(239,68,68,0.85)",
            boxShadow:  "0 4px 28px rgba(239,68,68,0.4)",
          }}
        >
          {/* Phone hang-up icon */}
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6 text-white"
            style={{ transform: "rotate(135deg)" }}>
            <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1l-2.3 2.2z"/>
          </svg>
        </button>
        <span
          className="text-[10px] font-medium uppercase tracking-widest"
          style={{ color: "rgba(255,255,255,0.22)" }}
        >
          End Call
        </span>
      </div>

      {/* Live indicator dot + voice label */}
      <div className="absolute bottom-12 left-6 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{
              background: color,
              animation: "voice-live 1.5s ease-in-out infinite",
            }}
          />
          <span className="text-[9px] uppercase tracking-widest" style={{ color: "rgba(255,255,255,0.2)" }}>
            Live
          </span>
        </div>
        <span className="text-[9px] uppercase tracking-widest" style={{ color: "rgba(255,255,255,0.15)" }}>
          Voice: {PERSONA_LABEL[persona]}
        </span>
      </div>
    </div>
  );
}
