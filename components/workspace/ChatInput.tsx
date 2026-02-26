"use client";

import {
  useState,
  useRef,
  useEffect,
  forwardRef,
  useImperativeHandle,
} from "react";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";

export type UIMode = "deep" | "fast" | "documents" | "premium";

export interface ChatInputHandle {
  focus: () => void;
}

const MODE_OPTIONS: {
  mode: UIMode;
  icon: string;
  label: string;
  description: string;
}[] = [
  { mode: "fast",      icon: "⚡", label: "Fast Response",  description: "Quick answers & summaries" },
  { mode: "deep",      icon: "🔍", label: "Deep Thinking",  description: "Thorough reasoning & analysis" },
  { mode: "documents", icon: "📄", label: "Documents Mode", description: "Document-focused legal search" },
  { mode: "premium",   icon: "✨", label: "Premium Mode",   description: "Maximum quality & reasoning" },
];

interface Props {
  onSend: (content: string) => void;
  disabled: boolean;
  activeChatId: string | null;
  activeCaseId: string | null;
  role: string | null;
  mode: UIMode;
  onModeChange: (mode: UIMode) => void;
}

// ── Transcription helper ──────────────────────────────────────────────────────
// Do NOT set Content-Type manually — the browser must set the multipart boundary.
async function transcribeBlob(blob: Blob): Promise<string> {
  // Derive an extension from the blob's MIME type (strip codec params)
  const base = (blob.type || "audio/webm").split(";")[0].trim();
  const extMap: Record<string, string> = {
    "audio/mp4": "mp4", "audio/m4a": "m4a",
    "audio/wav": "wav", "audio/ogg": "ogg",
    "audio/mpeg": "mp3", "audio/mp3": "mp3",
    "video/webm": "webm",
  };
  const ext = extMap[base] ?? "webm";

  const fd = new FormData();
  fd.append("audio", blob, `recording.${ext}`);

  // No { headers: { "Content-Type": ... } } — intentionally omitted
  const res = await fetch("/api/transcribe", { method: "POST", body: fd });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error ?? `Transcription failed (${res.status})`);
  }
  const json = await res.json();
  return (json.text ?? "").trim();
}

const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput(
  { onSend, disabled, activeChatId, activeCaseId, role, mode, onModeChange },
  ref
) {
  const [value, setValue] = useState("");
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // ── Voice state ───────────────────────────────────────────────
  // dictateMode: records → transcribes → fills textarea (user manually sends)
  // voiceMode:   records → transcribes → auto-sends
  const [voiceState, setVoiceState] = useState<"idle" | "dictate" | "voice">("idle");
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const { isRecording, startRecording, stopRecording, error: recorderError } = useVoiceRecorder();

  const textareaRef  = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuRef      = useRef<HTMLDivElement>(null);
  const menuBtnRef   = useRef<HTMLButtonElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }));

  // Click outside → close menu
  useEffect(() => {
    if (!isMenuOpen) return;
    function onMouseDown(e: MouseEvent) {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !menuBtnRef.current?.contains(t)) {
        setIsMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [isMenuOpen]);

  // ESC → close menu
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setIsMenuOpen(false);
      if (e.altKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        setIsMenuOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Surface recorder-level errors in the voice error slot
  useEffect(() => {
    if (recorderError) setVoiceError(recorderError);
  }, [recorderError]);

  function handleSend() {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setValue(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }

  async function handleUpload(file: File) {
    if (!activeChatId) return;
    setUploading(true);
    setUploadError(null);
    const formData = new FormData();
    formData.append("file", file);
    if (activeCaseId) {
      formData.append("scope", "case");
      formData.append("caseId", activeCaseId);
    } else {
      formData.append("scope", "global");
    }
    try {
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setUploadError(json.error ?? "Upload failed");
      }
    } catch {
      setUploadError("Network error during upload");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // ── Voice handlers ────────────────────────────────────────────

  async function handleDictateClick() {
    setVoiceError(null);

    if (isRecording && voiceState === "dictate") {
      // Stop → transcribe → insert into textarea
      setTranscribing(true);
      setVoiceState("idle");
      try {
        const blob = await stopRecording();
        if (!blob) return;
        const text = await transcribeBlob(blob);
        if (text) {
          setValue((prev) => (prev ? prev + " " + text : text));
          textareaRef.current?.focus();
        }
      } catch (err: unknown) {
        setVoiceError(err instanceof Error ? err.message : "Transcription failed");
      } finally {
        setTranscribing(false);
      }
    } else {
      // Start dictate recording
      setVoiceState("dictate");
      await startRecording();
    }
  }

  async function handleVoiceClick() {
    setVoiceError(null);

    if (isRecording && voiceState === "voice") {
      // Stop → transcribe → auto-send
      setTranscribing(true);
      setVoiceState("idle");
      try {
        const blob = await stopRecording();
        if (!blob) return;
        const text = await transcribeBlob(blob);
        if (text && !disabled) {
          onSend(text);
          setValue("");
        }
      } catch (err: unknown) {
        setVoiceError(err instanceof Error ? err.message : "Transcription failed");
      } finally {
        setTranscribing(false);
      }
    } else {
      // Start voice recording
      setVoiceState("voice");
      await startRecording();
    }
  }

  const canUpload = !!activeCaseId || role === "admin";
  const currentOption = MODE_OPTIONS.find((o) => o.mode === mode) ?? MODE_OPTIONS[0];

  const isDictating   = isRecording && voiceState === "dictate";
  const isVoicing     = isRecording && voiceState === "voice";
  const isBusy        = disabled || transcribing;

  return (
    <div className="border-t border-gray-200 dark:border-neutral-800 chat-canvas px-4 py-4 transition-colors duration-300">
      <div className="max-w-3xl mx-auto">
        <div className="relative">

          {/* ── Floating mode menu ─────────────────────────────── */}
          {isMenuOpen && (
            <div
              ref={menuRef}
              className="absolute bottom-full left-0 mb-3 z-50 w-64
                bg-white dark:bg-[#1a1a1a]
                border border-gray-200 dark:border-neutral-800
                rounded-xl shadow-2xl dark:shadow-black/50
                overflow-hidden menu-in"
            >
              <div className="p-1.5">
                {MODE_OPTIONS.map((opt) => (
                  <button
                    key={opt.mode}
                    onClick={() => {
                      onModeChange(opt.mode);
                      setIsMenuOpen(false);
                    }}
                    className={`w-full flex items-start gap-3 px-3 py-2.5 rounded-lg text-left transition-colors duration-150 ${
                      mode === opt.mode
                        ? "bg-gray-100 dark:bg-neutral-800"
                        : "hover:bg-gray-50 dark:hover:bg-neutral-800/60"
                    }`}
                  >
                    <span className="text-lg mt-0.5 flex-shrink-0">{opt.icon}</span>
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm font-medium ${
                        mode === opt.mode
                          ? "text-gray-900 dark:text-neutral-100"
                          : "text-gray-700 dark:text-neutral-300"
                      }`}>{opt.label}</p>
                      <p className="text-xs text-gray-400 dark:text-neutral-600 mt-0.5 leading-snug">
                        {opt.description}
                      </p>
                    </div>
                    {mode === opt.mode && (
                      <span className="ml-auto flex-shrink-0 text-indigo-500 dark:text-indigo-400 text-sm mt-1">✓</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Input row ──────────────────────────────────────── */}
          <div className={`flex items-end gap-2 rounded-2xl border shadow-sm px-4 py-3 transition-colors duration-300 ${
            isBusy
              ? "border-gray-200 dark:border-neutral-800 bg-gray-50 dark:bg-neutral-900"
              : "border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 focus-within:border-gray-400 dark:focus-within:border-neutral-600"
          }`}>

            {/* Mode button */}
            <button
              ref={menuBtnRef}
              type="button"
              onClick={() => setIsMenuOpen((v) => !v)}
              title={`Mode: ${currentOption.label} (Alt+M)`}
              aria-label={`Select AI mode — current: ${currentOption.label}`}
              className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-sm transition-all duration-200 ${
                isMenuOpen
                  ? "bg-gray-900 dark:bg-indigo-600 text-white scale-95"
                  : "bg-gray-100 dark:bg-neutral-800 text-gray-700 dark:text-neutral-300 hover:bg-gray-200 dark:hover:bg-neutral-700"
              }`}
            >
              {currentOption.icon}
            </button>

            <textarea
              ref={textareaRef}
              value={value}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              placeholder={
                isDictating   ? "Recording… tap mic to stop & transcribe"
                : isVoicing   ? "Recording… tap voice to stop & send"
                : transcribing ? "Transcribing…"
                : "Ask about a case, law, section, or legal strategy…"
              }
              disabled={isBusy}
              rows={1}
              className="flex-1 resize-none bg-transparent text-sm text-gray-800 dark:text-neutral-100 placeholder-gray-400 dark:placeholder-neutral-600 focus:outline-none disabled:cursor-not-allowed leading-relaxed"
              style={{ maxHeight: 160, minHeight: 24 }}
            />

            {/* ── Dictate button (mic → fills textarea) ── */}
            <button
              type="button"
              onClick={handleDictateClick}
              disabled={isBusy || isVoicing}
              title={isDictating ? "Stop recording & transcribe" : "Dictate (speech to text)"}
              aria-label={isDictating ? "Stop dictation" : "Start dictation"}
              className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-all duration-200 ${
                isDictating
                  ? "bg-red-500 text-white animate-pulse"
                  : "text-gray-400 dark:text-neutral-500 hover:text-gray-600 dark:hover:text-neutral-300 disabled:opacity-30 disabled:cursor-not-allowed"
              }`}
            >
              {transcribing && voiceState === "idle" ? (
                // spinner shown briefly during transcribe after dictate
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8"  y1="23" x2="16" y2="23" />
                </svg>
              )}
            </button>

            {/* ── Voice button (mic → auto-send) ── */}
            <button
              type="button"
              onClick={handleVoiceClick}
              disabled={isBusy || isDictating}
              title={isVoicing ? "Stop recording & send" : "Voice mode (auto-send)"}
              aria-label={isVoicing ? "Stop voice mode" : "Start voice mode"}
              className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-all duration-200 ${
                isVoicing
                  ? "bg-indigo-500 text-white animate-pulse"
                  : "text-gray-400 dark:text-neutral-500 hover:text-gray-600 dark:hover:text-neutral-300 disabled:opacity-30 disabled:cursor-not-allowed"
              }`}
            >
              {transcribing && isVoicing ? (
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
              ) : (
                // Waveform icon to visually distinguish from dictate
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                </svg>
              )}
            </button>

            {/* Paperclip upload */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || !canUpload || !activeChatId}
              title={
                !activeChatId ? "Start a chat first"
                : !canUpload  ? "Link a case to upload documents"
                : "Upload document"
              }
              className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-gray-400 dark:text-neutral-500 hover:text-gray-600 dark:hover:text-neutral-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors duration-200"
            >
              {uploading ? (
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                </svg>
              )}
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept=".docx,.txt,.pdf"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleUpload(file);
              }}
            />

            {/* Send button */}
            <button
              onClick={handleSend}
              disabled={isBusy || !value.trim()}
              className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-900 dark:bg-indigo-600 text-white flex items-center justify-center hover:bg-gray-700 dark:hover:bg-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-200"
              aria-label="Send message"
            >
              {isBusy ? (
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
              )}
            </button>

          </div>
        </div>

        {/* Error display (upload or voice) */}
        {(uploadError || voiceError) && (
          <p className="text-xs text-red-500 dark:text-red-400 mt-1.5 text-center">
            {uploadError ?? voiceError}
          </p>
        )}

        <p className="text-center text-xs text-gray-400 dark:text-neutral-600 mt-2">
          Harvey can make mistakes. Verify important legal advice.
        </p>
      </div>
    </div>
  );
});

export default ChatInput;
