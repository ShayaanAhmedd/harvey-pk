"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import ChatSidebar, { type Chat } from "./ChatSidebar";
import ChatWindow, { type Message } from "./ChatWindow";
import ChatInput, { type UIMode, type ChatInputHandle } from "./ChatInput";

interface Props {
  userId: string;
  userEmail: string;
  role: string | null;
}

export default function WorkspaceShell({ userId: _userId, userEmail, role }: Props) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [activeCaseId, setActiveCaseId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [newChatLoading, setNewChatLoading] = useState(false);
  const [mode, setMode] = useState<UIMode>("fast");

  // Ref-lock: prevents concurrent auto-creations on double-tap
  const creatingChat = useRef(false);
  // Ref to ChatInput's focus() handle
  const chatInputRef = useRef<ChatInputHandle>(null);

  // ── Boot: fetch chat list ──────────────────────────────────
  useEffect(() => {
    fetchChats();
  }, []);

  async function fetchChats() {
    try {
      const res = await fetch("/api/chats");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setInitError(body?.detail?.message ?? body?.error ?? `API error ${res.status}`);
        return;
      }
      const data: Chat[] = await res.json();
      setChats(Array.isArray(data) ? data : []);
      setInitError(null);
    } catch (err: unknown) {
      setInitError(err instanceof Error ? err.message : "Network error loading chats");
    }
  }

  // ── Select a chat ──────────────────────────────────────────
  const handleSelectChat = useCallback(async (chatId: string) => {
    setActiveChatId(chatId);
    setMessages([]);
    setChatLoading(true);
    try {
      const res = await fetch(`/api/chats/${chatId}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.error("Chat load error:", body?.error ?? `HTTP ${res.status}`);
        if (res.status === 404) {
          setActiveChatId(null);
          setActiveCaseId(null);
        }
        return;
      }
      const { chat, messages: msgs } = await res.json();
      setMessages(Array.isArray(msgs) ? msgs : []);
      setActiveCaseId(chat?.case_id ?? null);
    } catch (err) {
      console.error("Chat load error:", err);
    } finally {
      setChatLoading(false);
    }
  }, []);

  // ── Create chat (ref-locked) ───────────────────────────────
  async function createChat(): Promise<string | null> {
    if (creatingChat.current) return null;
    creatingChat.current = true;
    setNewChatLoading(true);
    try {
      const res = await fetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setInitError(body?.detail?.message ?? body?.error ?? `Error ${res.status}`);
        return null;
      }
      const newChat: Chat = await res.json();
      setChats((prev) => [newChat, ...prev]);
      setActiveChatId(newChat.id);
      setActiveCaseId(null);
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

  async function handleNewChat() {
    if (newChatLoading) return;
    await createChat();
  }

  async function handleDeleteChat(chatId: string) {
    try {
      const res = await fetch(`/api/chats/${chatId}`, { method: "DELETE" });
      if (!res.ok) return;
      setChats((prev) => prev.filter((c) => c.id !== chatId));
      if (activeChatId === chatId) {
        setActiveChatId(null);
        setActiveCaseId(null);
        setMessages([]);
      }
    } catch {
      // non-fatal
    }
  }

  // ── Card click from welcome screen ─────────────────────────
  function handleModeSelect(selectedMode: UIMode) {
    setMode(selectedMode);
    // Focus textarea after state settles
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

    try {
      const res = await fetch(`/api/chats/${chatId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, mode }),
      });

      if (!res.ok || !res.body) {
        const errBody = await res.json().catch(() => ({}));
        const msg = errBody?.error ?? `Error ${res.status}`;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === streamId
              ? { ...m, content: `⚠ Could not get a response: ${msg}`, streaming: false }
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
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === streamId ? { ...m, content: m.content + parsed.content } : m
                )
              );
            } else if (parsed.type === "done") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === streamId
                    ? {
                        ...m,
                        sources: parsed.message?.sources ?? null,
                        created_at: parsed.message?.created_at ?? m.created_at,
                        streaming: false,
                      }
                    : m
                )
              );
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
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-50 max-w-lg w-full mx-4">
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 shadow-sm flex items-start gap-3">
            <span className="text-red-500 flex-shrink-0 mt-0.5">⚠</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-red-800">Error</p>
              <p className="text-xs text-red-600 mt-0.5 break-words">{initError}</p>
            </div>
            <button
              onClick={() => setInitError(null)}
              className="text-red-400 hover:text-red-600 flex-shrink-0 text-lg leading-none"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* LEFT: Sidebar */}
      <ChatSidebar
        chats={chats}
        activeChatId={activeChatId}
        userEmail={userEmail}
        role={role}
        newChatLoading={newChatLoading}
        onNewChat={handleNewChat}
        onSelectChat={handleSelectChat}
        onDeleteChat={handleDeleteChat}
      />

      {/* CENTER: Chat (full width) */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <ChatWindow
          messages={messages}
          loading={sending}
          chatLoading={chatLoading}
          activeChatId={activeChatId}
          onModeSelect={handleModeSelect}
        />

        <ChatInput
          ref={chatInputRef}
          onSend={handleSend}
          disabled={sending || chatLoading}
          activeChatId={activeChatId}
          activeCaseId={activeCaseId}
          role={role}
          mode={mode}
          onModeChange={setMode}
        />
      </main>

    </div>
  );
}
