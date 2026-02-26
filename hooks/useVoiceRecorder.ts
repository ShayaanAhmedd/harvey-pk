"use client";

// useVoiceRecorder
//
// MediaRecorder wrapper. Produces a Blob + mimeType for /api/transcribe.
// The caller must NOT set Content-Type on the fetch — let the browser
// set the multipart boundary automatically.

import { useRef, useState, useCallback } from "react";

export type UseVoiceRecorderReturn = {
  isRecording: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<Blob | null>;
  error: string | null;
};

// Pick the best supported MIME type at runtime.
// audio/webm is universally supported in Chrome.
// audio/mp4 is preferred on Safari / newer Chrome.
function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";

  const candidates = [
    "audio/mp4",
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];

  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }

  return ""; // let the browser decide
}

export function useVoiceRecorder(): UseVoiceRecorderReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError]             = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef   = useRef<Blob[]>([]);
  const streamRef   = useRef<MediaStream | null>(null);
  const resolveRef  = useRef<((blob: Blob | null) => void) | null>(null);

  const startRecording = useCallback(async () => {
    setError(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Microphone access is not supported in this browser.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;
      chunksRef.current = [];

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        // Release the mic indicator immediately
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;

        const blob = chunksRef.current.length > 0
          ? new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" })
          : null;

        resolveRef.current?.(blob);
        resolveRef.current = null;
      };

      recorder.onerror = () => {
        setError("Recording failed. Please try again.");
        setIsRecording(false);
      };

      recorder.start(250); // chunk every 250 ms
      setIsRecording(true);
    } catch (err: unknown) {
      const msg   = err instanceof Error ? err.message : String(err);
      const clean = /NotAllowedError|Permission denied/i.test(msg)
        ? "Microphone permission denied. Allow mic access in browser settings."
        : msg;
      setError(clean);
    }
  }, []);

  const stopRecording = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === "inactive") {
        setIsRecording(false);
        resolve(null);
        return;
      }
      resolveRef.current = resolve;
      recorder.stop();
      setIsRecording(false);
    });
  }, []);

  return { isRecording, startRecording, stopRecording, error };
}
