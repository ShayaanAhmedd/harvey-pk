"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import ChatSidebar, { type Chat } from "./ChatSidebar";
import CursorGlow from "./CursorGlow";
import { playClick, playAiStart, playSuccess, playError } from "@/lib/sounds";
import ChatWindow, { type Message, type Source } from "./ChatWindow";
import ChatInput, { type UIMode, type ChatInputHandle } from "./ChatInput";
import DocumentBar, { type UploadedDocument } from "./DocumentBar";
import DashboardView from "./DashboardView";
import DocumentInfoCard from "./DocumentInfoCard";
import ClockWidget, { type ClockPosition } from "./ClockWidget";
import AnalogClockWidget, { type ClockSize } from "./AnalogClockWidget";
import VoiceMode, { type TranscriptEntry } from "./VoiceMode";
import EmailConfirmModal from "./EmailConfirmModal";
import { parseUICommands, executeUICommand } from "@/lib/ui-actions";
import { parseEmailDraft, type EmailDraft } from "@/lib/email-draft";

type WorkspaceMode = "dashboard" | "chat" | "document";

interface Props {
  userId: string;
  userEmail: string;
  role: string | null;
}

export default function WorkspaceShell({ userId: _userId, userEmail, role }: Props) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [activeCaseId, setActiveCaseId] = useState<string | null>(null);
  const [activeCaseName, setActiveCaseName] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [documents, setDocuments] = useState<UploadedDocument[]>([]);
  const [activeDocName, setActiveDocName] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [newChatLoading, setNewChatLoading] = useState(false);
  const [mode, setMode] = useState<UIMode>("fast");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("dashboard");
  const [lastUploadedDoc, setLastUploadedDoc] = useState<UploadedDocument | null>(null);
  const [clockShow, setClockShow]     = useState(false);
  const [clockPos,  setClockPos]      = useState<ClockPosition>("bottom-right");
  const [clockType, setClockType]     = useState<"flip" | "analog">("flip");
  const [clockSize, setClockSize]     = useState<ClockSize>("md");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [voiceModeOpen, setVoiceModeOpen] = useState(false);
  const [emailDraft, setEmailDraft] = useState<EmailDraft | null>(null);

  // Ref-lock: prevents concurrent auto-creations on double-tap
  const creatingChat = useRef(false);
  // Ref to ChatInput's focus() handle
  const chatInputRef = useRef<ChatInputHandle>(null);
  // Tracks accumulated SSE stream content so UI commands can be parsed on done
  const streamContentRef = useRef<string>("");

  // ── Load clock prefs from localStorage on mount ────────────
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("harvey_appearance") ?? "{}");
      if (typeof saved.showClock === "boolean") setClockShow(saved.showClock);
      if (saved.clockPosition) setClockPos(saved.clockPosition as ClockPosition);
      if (saved.clockType === "analog" || saved.clockType === "flip") setClockType(saved.clockType);
      if (saved.clockSize === "sm" || saved.clockSize === "md" || saved.clockSize === "lg") setClockSize(saved.clockSize);
    } catch {
      // ignore parse errors
    }
  }, []);

  // ── WhatsApp send result: append inline status to last assistant message ──
  useEffect(() => {
    function onWaResult(e: Event) {
      const { ok, to, error } = (e as CustomEvent).detail as {
        ok: boolean; to: string; error: string | null;
      };
      const text = ok
        ? `\n\n_✓ WhatsApp delivered to **${to}**_`
        : `\n\n_⚠ WhatsApp to **${to}** failed: ${error ?? "unknown error"}_`;

      setMessages((prev) => {
        // Append the status to the last assistant message
        const lastIdx = [...prev].reverse().findIndex((m) => m.role === "assistant");
        if (lastIdx === -1) return prev;
        const realIdx = prev.length - 1 - lastIdx;
        return prev.map((m, i) =>
          i === realIdx ? { ...m, content: m.content + text } : m
        );
      });
    }
    window.addEventListener("harvey:whatsapp-result", onWaResult);
    return () => window.removeEventListener("harvey:whatsapp-result", onWaResult);
  }, []);

  // ── Sync clock/appearance state when AI changes prefs ──────
  useEffect(() => {
    function onPrefsChanged(e: Event) {
      const prefs = (e as CustomEvent).detail as Record<string, unknown>;
      if (typeof prefs.showClock === "boolean") setClockShow(prefs.showClock);
      if (prefs.clockPosition) setClockPos(prefs.clockPosition as ClockPosition);
      if (prefs.clockType === "analog" || prefs.clockType === "flip") setClockType(prefs.clockType);
      if (prefs.clockSize === "sm" || prefs.clockSize === "md" || prefs.clockSize === "lg") setClockSize(prefs.clockSize as "sm" | "md" | "lg");
    }
    window.addEventListener("harvey:prefs-changed", onPrefsChanged);
    return () => window.removeEventListener("harvey:prefs-changed", onPrefsChanged);
  }, []);

  // ── Boot: fetch chat list + restore active chat from localStorage ──
  useEffect(() => {
    fetchChats();
    const saved = localStorage.getItem("harvey_activeChatId");
    if (saved) setActiveChatId(saved);
  }, []);

  // ── Persist active chat ID to localStorage ─────────────────
  useEffect(() => {
    if (activeChatId) {
      localStorage.setItem("harvey_activeChatId", activeChatId);
    } else {
      localStorage.removeItem("harvey_activeChatId");
    }
  }, [activeChatId]);

  function handleUploadSuccess(doc: { file_name: string; totalChunks: number; scope: string }) {
    setDocuments((prev) => {
      const exists = prev.some((d) => d.file_name === doc.file_name);
      return exists ? prev : [doc, ...prev];
    });
    setActiveDocName(doc.file_name);
    setLastUploadedDoc(doc);
    setWorkspaceMode("document");
  }

  function handleDocumentAskAbout() {
    setWorkspaceMode("chat");
    setTimeout(() => chatInputRef.current?.focus(), 0);
  }

  async function deleteEmptyChat(chatId: string) {
    setChats((prev) => prev.filter((c) => c.id !== chatId));
    fetch(`/api/chats/${chatId}`, { method: "DELETE" }).catch(() => {});
  }

  async function fetchChats() {
    try {
      const res = await fetch("/api/chats");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setInitError(body?.detail?.message ?? body?.error ?? `API error ${res.status}`);
        return;
      }
      const data: Chat[] = await res.json();
      const all = Array.isArray(data) ? data : [];

      // Silently delete any "New Chat" chats from previous sessions
      // (title stays "New Chat" only if no message was ever sent)
      const currentId = activeChatId;
      all
        .filter((c) => c.title === "New Chat" && c.id !== currentId)
        .forEach((c) => fetch(`/api/chats/${c.id}`, { method: "DELETE" }).catch(() => {}));

      setChats(all.filter((c) => c.title !== "New Chat" || c.id === currentId));
      setInitError(null);
    } catch (err: unknown) {
      setInitError(err instanceof Error ? err.message : "Network error loading chats");
    }
  }

  // ── Select a chat ──────────────────────────────────────────
  const handleSelectChat = useCallback(async (chatId: string) => {
    // Prune the previous chat if it was never used (title still "New Chat")
    const prevChat = chats.find((c) => c.id === activeChatId);
    if (prevChat?.title === "New Chat" && prevChat.id !== chatId) {
      deleteEmptyChat(prevChat.id);
    }

    setWorkspaceMode("chat");
    setActiveChatId(chatId);
    setMessages([]);
    setChatLoading(true);
    try {
      const res = await fetch(`/api/chats/${chatId}`);
      if (!res.ok) {
        await res.json().catch(() => ({}));
        if (res.status === 404) {
          setActiveChatId(null);
          setActiveCaseId(null);
          setActiveCaseName(null);
        }
        return;
      }
      const { chat, messages: msgs } = await res.json();
      setMessages(Array.isArray(msgs) ? msgs : []);
      const caseId = chat?.case_id ?? null;
      setActiveCaseId(caseId);
      // Fetch case name for the header
      if (caseId) {
        fetch(`/api/cases/${caseId}`)
          .then((r) => r.ok ? r.json() : null)
          .then((c) => setActiveCaseName(c?.title ?? null))
          .catch(() => {});
      } else {
        setActiveCaseName(null);
      }
    } catch {
      // non-fatal — chat load failure leaves the UI in its previous state
    } finally {
      setChatLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, activeChatId]);

  // ── Create chat (ref-locked) ───────────────────────────────
  async function createChat(caseId?: string | null): Promise<string | null> {
    if (creatingChat.current) return null;
    creatingChat.current = true;
    setNewChatLoading(true);
    try {
      const res = await fetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(caseId ? { case_id: caseId } : {}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setInitError(body?.detail?.message ?? body?.error ?? `Error ${res.status}`);
        return null;
      }
      const newChat: Chat = await res.json();
      setChats((prev) => [newChat, ...prev]);
      setActiveChatId(newChat.id);
      setActiveCaseId(caseId ?? null);
      setActiveCaseName(null); // caller sets name separately if needed
      setMessages([]);
      setInitError(null);
      return newChat.id;
    } catch (err: unknown) {
      setInitError(err instanceof Error ? err.message : "Network error");
      return null;
    } finally {
      creatingChat.current = false;
      setNewChatLoading(false);
    }
  }

  // ── Voice call end: save transcript + show summary in chat ────
  async function handleCallEnd(transcript: TranscriptEntry[]) {
    if (transcript.length === 0) return;

    // Switch to chat so the summary is immediately visible
    setWorkspaceMode("chat");

    let chatId = activeChatId;
    if (!chatId) {
      chatId = await createChat();
      if (!chatId) return;
    }

    // Helper: always renders transcript regardless of whether summary worked
    const buildContent = (summary: string | null) => {
      const transcriptMd = transcript
        .map((e) => `**${e.role === "user" ? "You" : "Harvey"}** _(${e.time})_: ${e.text}`)
        .join("\n\n");

      if (summary) {
        return `**Call Summary**\n\nSummary:\n${summary}\n\n---\n\nTranscript:\n\n${transcriptMd}`;
      }
      return `**Call Transcript**\n\nTranscript:\n\n${transcriptMd}`;
    };

    const summaryId = `voice-summary-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: summaryId,
        role: "assistant" as const,
        content: "_Generating voice call summary…_",
        created_at: new Date().toISOString(),
        streaming: true,
      },
    ]);

    let content = buildContent(null); // fallback: transcript only
    try {
      const res = await fetch("/api/voice/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript,
          chat_id: chatId,
          case_id: activeCaseId ?? undefined,
        }),
      });

      if (res.ok) {
        const { summary } = await res.json() as { id: string; summary: string };
        if (summary) content = buildContent(summary);
      }
    } catch {
      // non-fatal — fall through with transcript-only content
    }

    setMessages((prev) =>
      prev.map((m) =>
        m.id === summaryId ? { ...m, content, streaming: false } : m
      )
    );
  }

  async function handleNewChat() {
    if (newChatLoading) return;
    // Capture previous chat before creating a new one
    const prevChat = chats.find((c) => c.id === activeChatId);
    const newId = await createChat();
    // Only prune the previous empty chat after successfully getting a new ID,
    // and never delete the chat we're switching to
    if (newId && prevChat?.title === "New Chat" && prevChat.id !== newId) {
      deleteEmptyChat(prevChat.id);
    }
    // Show dashboard after creating chat — wait for user to type rather than blank chat
    if (newId) setWorkspaceMode("dashboard");
  }

  async function handleDeleteChat(chatId: string) {
    try {
      const res = await fetch(`/api/chats/${chatId}`, { method: "DELETE" });
      if (!res.ok) return;
      setChats((prev) => prev.filter((c) => c.id !== chatId));
      if (activeChatId === chatId) {
        setActiveChatId(null);
        setActiveCaseId(null);
        setActiveCaseName(null);
        setMessages([]);
      }
    } catch {
      // non-fatal
    }
  }

  // ── Enter chat mode without creating a new chat ────────────
  function handleEnterChatMode() {
    setWorkspaceMode("chat");
    setTimeout(() => chatInputRef.current?.focus(), 0);
  }

  // ── Card click from welcome screen ─────────────────────────
  function handleModeSelect(selectedMode: UIMode) {
    setMode(selectedMode);
    setWorkspaceMode("chat");
    setTimeout(() => chatInputRef.current?.focus(), 0);
  }

  // ── Send message (SSE streaming) ───────────────────────────
  async function handleSend(content: string) {
    if (sending) return;

    let chatId = activeChatId;
    if (!chatId) {
      chatId = await createChat();
      if (!chatId) return;
    }

    const streamId = `stream-${Date.now()}`;
    const tempUser: Message = {
      id: `user-${Date.now()}`,
      role: "user",
      content,
      created_at: new Date().toISOString(),
    };
    const tempAssistant: Message = {
      id: streamId,
      role: "assistant",
      content: "",
      created_at: new Date().toISOString(),
      streaming: true,
    };

    setMessages((prev) => [...prev, tempUser, tempAssistant]);
    setSending(true);
    playClick();
    streamContentRef.current = ""; // reset accumulator for this request

    // track whether we've fired the "AI started" sound yet for this request
    let aiStartFired = false;

    try {
      let res = await fetch(`/api/chats/${chatId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, mode }),
      });

      // Fix 3 — chat was deleted externally: recreate and retry once
      if (res.status === 404) {
        setActiveChatId(null);
        const newChatId = await createChat();
        if (!newChatId) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamId
                ? { ...m, content: "⚠ Could not create a new chat session. Please try again.", streaming: false }
                : m
            )
          );
          playError();
          return;
        }
        chatId = newChatId;
        res = await fetch(`/api/chats/${chatId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, mode }),
        });
      }

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const msg = errBody?.error ?? `Error ${res.status}`;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === streamId
              ? { ...m, content: `⚠ Could not get a response: ${msg}`, streaming: false }
              : m
          )
        );
        playError();
        return;
      }

      // Deep Mode returns a full JSON body instead of an SSE stream.
      // Detect by Content-Type and handle before entering the SSE reader.
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const json = await res.json().catch(() => ({})) as {
          success?: boolean;
          irac?: Record<string, unknown>;
          error?: string;
          message?: { id?: string; sources?: Source[] | null; created_at?: string } | null;
        };
        if (json.success === true) {
          playAiStart();
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamId
                ? {
                    ...m,
                    id:         json.message?.id         ?? m.id,
                    content:    JSON.stringify(json.irac),
                    sources:    json.message?.sources    ?? null,
                    created_at: json.message?.created_at ?? m.created_at,
                    streaming:  false,
                  }
                : m
            )
          );
          playSuccess();
          fetchChats();
        } else {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamId
                ? { ...m, content: `⚠ ${json.error ?? "Deep mode temporarily unavailable."}`, streaming: false }
                : m
            )
          );
          playError();
        }
        return;
      }

      if (!res.body) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === streamId
              ? { ...m, content: "⚠ Could not get a response: empty body", streaming: false }
              : m
          )
        );
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const event of events) {
          const line = event.trim();
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice("data: ".length).trim();
          if (raw === "[DONE]") continue;
          try {
            const parsed = JSON.parse(raw);
            if (parsed.type === "chunk" && typeof parsed.content === "string") {
              if (!aiStartFired) { playAiStart(); aiStartFired = true; }
              streamContentRef.current += parsed.content;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === streamId ? { ...m, content: m.content + parsed.content } : m
                )
              );
            } else if (parsed.type === "done") {
              // Parse and execute UI commands, then strip email drafts
              const { clean: cleanUI, commands } = parseUICommands(streamContentRef.current);
              commands.forEach(executeUICommand);
              const { clean, draft } = parseEmailDraft(cleanUI);
              if (draft) setEmailDraft(draft);
              const didModify = commands.length > 0 || draft !== null;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === streamId
                    ? {
                        ...m,
                        content:    didModify ? clean : m.content,
                        sources:    parsed.message?.sources ?? null,
                        created_at: parsed.message?.created_at ?? m.created_at,
                        streaming:  false,
                      }
                    : m
                )
              );
              playSuccess();
              fetchChats();
            }
          } catch {
            // skip malformed
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Network error";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === streamId
            ? { ...m, content: `⚠ Could not get a response: ${msg}`, streaming: false }
            : m
        )
      );
      playError();
    } finally {
      setSending(false);
      setMessages((prev) =>
        prev.map((m) => (m.streaming ? { ...m, streaming: false } : m))
      );
    }
  }

  // ── Layout ─────────────────────────────────────────────────
  return (
    <div className="flex h-full">

      {/* ── Error banner ── */}
      {initError && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-md w-full mx-4 scale-in">
          <div className="glass rounded-2xl px-4 py-3 shadow-xl border-red-200/60 flex items-start gap-3">
            <span className="text-red-500 flex-shrink-0 mt-0.5 text-sm">⚠</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-red-700">Error</p>
              <p className="text-xs text-red-500 mt-0.5 break-words leading-relaxed">{initError}</p>
            </div>
            <button
              onClick={() => setInitError(null)}
              className="text-gray-400 hover:text-gray-600 flex-shrink-0 text-lg leading-none transition-colors"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* LEFT: Sidebar */}
      <ChatSidebar
        chats={chats.filter((c) => c.title !== "New Chat")}
        activeChatId={activeChatId}
        userEmail={userEmail}
        role={role}
        newChatLoading={newChatLoading}
        onNewChat={handleNewChat}
        onSelectChat={handleSelectChat}
        onDeleteChat={handleDeleteChat}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed(v => !v)}
      />

      {/* CENTER: Workspace */}
      <main className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-neutral-950">

        {/* Top document bar — visible when docs are indexed */}
        <DocumentBar
          documents={documents}
          activeDocName={activeDocName}
          onSelectDoc={(name) => {
            setActiveDocName(name);
            setWorkspaceMode("chat");
          }}
        />

        {/* ── Mode: Dashboard ── */}
        {workspaceMode === "dashboard" && (
          <div key="dashboard" className="mode-enter flex-1 flex flex-col overflow-hidden">
            <DashboardView
              chats={chats.filter((c) => c.title !== "New Chat")}
              documents={documents}
              onSelectChat={handleSelectChat}
              onEnterChat={handleEnterChatMode}
            />
          </div>
        )}

        {/* ── Mode: Document info card ── */}
        {workspaceMode === "document" && lastUploadedDoc && (
          <div key="document" className="mode-enter flex-1 flex flex-col overflow-hidden">
            <DocumentInfoCard
              document={lastUploadedDoc}
              onAskAbout={handleDocumentAskAbout}
            />
          </div>
        )}

        {/* ── Mode: Chat ── */}
        {workspaceMode === "chat" && (
          <div key="chat" className="mode-enter flex-1 flex flex-col overflow-hidden">
            <ChatWindow
              messages={messages}
              loading={sending}
              chatLoading={chatLoading}
              activeChatId={activeChatId}
              activeCaseName={activeCaseName}
              mode={mode}
              onModeSelect={handleModeSelect}
            />
          </div>
        )}

        <ChatInput
          ref={chatInputRef}
          onSend={(content) => {
            // Typing a message from dashboard or document mode → enter chat
            if (workspaceMode !== "chat") setWorkspaceMode("chat");
            handleSend(content);
          }}
          disabled={sending || chatLoading}
          activeChatId={activeChatId}
          activeCaseId={activeCaseId}
          role={role}
          mode={mode}
          onModeChange={setMode}
          onUploadSuccess={handleUploadSuccess}
          activeDocName={activeDocName}
          documents={documents}
          onOpenVoiceMode={() => setVoiceModeOpen(true)}
        />
      </main>

      {clockShow && clockType === "flip"   && <ClockWidget position={clockPos} />}
      {clockShow && clockType === "analog" && <AnalogClockWidget position={clockPos} size={clockSize} />}
      {emailDraft && (
        <EmailConfirmModal
          draft={emailDraft}
          onClose={() => setEmailDraft(null)}
        />
      )}
      {voiceModeOpen && (
        <VoiceMode
          onClose={(transcript) => {
            setVoiceModeOpen(false);
            handleCallEnd(transcript);
          }}
        />
      )}
      <CursorGlow />
    </div>
  );
}
