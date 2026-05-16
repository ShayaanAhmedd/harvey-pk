"use client";

import { useState, useEffect } from "react";

interface EmailConfig {
  smtp_host:  string;
  smtp_port:  number;
  smtp_user:  string;
  smtp_pass:  string;
  from_email: string;
  from_name:  string;
}

const EMPTY: EmailConfig = {
  smtp_host:  "",
  smtp_port:  587,
  smtp_user:  "",
  smtp_pass:  "",
  from_email: "",
  from_name:  "",
};

export default function EmailPanel() {
  const [connected, setConnected]   = useState(false);
  const [cfg, setCfg]               = useState<EmailConfig>(EMPTY);
  const [status, setStatus]         = useState<"idle" | "saving" | "disconnecting">("idle");
  const [feedback, setFeedback]     = useState<{ ok: boolean; msg: string } | null>(null);
  const [showPass, setShowPass]     = useState(false);

  useEffect(() => {
    fetch("/api/email/settings")
      .then((r) => r.json())
      .then((d) => {
        if (d.connected) {
          setConnected(true);
          setCfg({
            smtp_host:  d.smtp_host  ?? "",
            smtp_port:  d.smtp_port  ?? 587,
            smtp_user:  d.smtp_user  ?? "",
            smtp_pass:  "",            // never returned from server
            from_email: d.from_email ?? "",
            from_name:  d.from_name  ?? "",
          });
        }
      })
      .catch(() => {});
  }, []);

  function patch(key: keyof EmailConfig, value: string | number) {
    setCfg((prev) => ({ ...prev, [key]: value }));
    setFeedback(null);
  }

  async function handleSave() {
    setStatus("saving");
    setFeedback(null);
    try {
      const res = await fetch("/api/email/settings", {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      });
      const data = await res.json();
      if (res.ok) {
        setConnected(true);
        setCfg((prev) => ({ ...prev, smtp_pass: "" })); // clear pass from state
        setFeedback({ ok: true, msg: "Email connected successfully." });
      } else {
        setFeedback({ ok: false, msg: data.error ?? "Failed to save." });
      }
    } catch {
      setFeedback({ ok: false, msg: "Network error." });
    } finally {
      setStatus("idle");
    }
  }

  async function handleDisconnect() {
    setStatus("disconnecting");
    setFeedback(null);
    try {
      const res = await fetch("/api/email/settings", { method: "DELETE" });
      if (res.ok) {
        setConnected(false);
        setCfg(EMPTY);
        setFeedback({ ok: true, msg: "Email disconnected." });
      } else {
        const data = await res.json();
        setFeedback({ ok: false, msg: data.error ?? "Failed to disconnect." });
      }
    } catch {
      setFeedback({ ok: false, msg: "Network error." });
    } finally {
      setStatus("idle");
    }
  }

  return (
    <div className="bg-[#111111] rounded-xl border border-neutral-800 overflow-hidden">

      {/* Status bar */}
      <div className="px-5 py-3 bg-neutral-900/60 border-b border-neutral-800 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${connected ? "bg-emerald-500" : "bg-neutral-600"}`} />
          <span className="text-xs text-neutral-400 font-medium">
            {connected ? "Email connected" : "Not connected"}
          </span>
        </div>
        {connected && (
          <span className="text-[11px] text-neutral-600">
            Harvey can draft emails — you confirm before anything is sent.
          </span>
        )}
      </div>

      {/* Form */}
      <div className="divide-y divide-neutral-800/60">

        <FormRow label="From Name" hint="Displayed as the sender name">
          <input
            type="text"
            value={cfg.from_name}
            onChange={(e) => patch("from_name", e.target.value)}
            placeholder="Harvey Legal"
            className={INPUT}
          />
        </FormRow>

        <FormRow label="From Email" hint="The email address emails are sent from">
          <input
            type="email"
            value={cfg.from_email}
            onChange={(e) => patch("from_email", e.target.value)}
            placeholder="harvey@lawfirm.pk"
            className={INPUT}
          />
        </FormRow>

        <FormRow label="SMTP Host" hint="e.g. smtp.gmail.com · smtp.office365.com">
          <input
            type="text"
            value={cfg.smtp_host}
            onChange={(e) => patch("smtp_host", e.target.value)}
            placeholder="smtp.gmail.com"
            className={INPUT}
          />
        </FormRow>

        <FormRow label="SMTP Port" hint="Usually 587 (STARTTLS) or 465 (SSL)">
          <input
            type="number"
            value={cfg.smtp_port}
            onChange={(e) => patch("smtp_port", Number(e.target.value))}
            placeholder="587"
            className={`${INPUT} w-28`}
          />
        </FormRow>

        <FormRow label="Username" hint="Usually your full email address">
          <input
            type="text"
            value={cfg.smtp_user}
            onChange={(e) => patch("smtp_user", e.target.value)}
            placeholder="harvey@lawfirm.pk"
            className={INPUT}
          />
        </FormRow>

        <FormRow label="App Password" hint={connected ? "Leave blank to keep existing password" : "Use an App Password for Gmail / Outlook"}>
          <div className="flex items-center gap-2">
            <input
              type={showPass ? "text" : "password"}
              value={cfg.smtp_pass}
              onChange={(e) => patch("smtp_pass", e.target.value)}
              placeholder={connected ? "••••••••  (unchanged)" : "App password"}
              className={INPUT}
            />
            <button
              type="button"
              onClick={() => setShowPass((v) => !v)}
              className="text-[11px] text-neutral-500 hover:text-neutral-300 transition-colors px-1 flex-shrink-0"
            >
              {showPass ? "Hide" : "Show"}
            </button>
          </div>
        </FormRow>

      </div>

      {/* Actions */}
      <div className="px-5 py-4 flex items-center justify-between gap-4 bg-neutral-900/30">
        <div className="min-w-0">
          {feedback && (
            <p className={`text-[12px] font-medium ${feedback.ok ? "text-emerald-400" : "text-red-400"}`}>
              {feedback.msg}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {connected && (
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={status !== "idle"}
              className="text-xs px-3 py-1.5 rounded-lg border border-neutral-700 text-neutral-400 hover:text-red-400 hover:border-red-800 disabled:opacity-40 transition-colors"
            >
              {status === "disconnecting" ? "Disconnecting…" : "Disconnect"}
            </button>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={status !== "idle" || !cfg.smtp_host || !cfg.smtp_user || !cfg.from_email || (!connected && !cfg.smtp_pass)}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            {status === "saving" ? "Saving…" : connected ? "Update" : "Connect Email"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────────

const INPUT =
  "w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-1.5 text-sm text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-indigo-500 transition-colors";

function FormRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint:  string;
  children: React.ReactNode;
}) {
  return (
    <div className="px-5 py-4 flex items-start justify-between gap-6">
      <div className="min-w-0 flex-shrink-0 w-40">
        <p className="text-sm font-medium text-neutral-300">{label}</p>
        <p className="text-[11px] text-neutral-600 mt-0.5 leading-relaxed">{hint}</p>
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
