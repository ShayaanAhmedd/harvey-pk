"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import HarveyLogo from "@/components/ui/HarveyLogo";

export type Chat = {
  id: string;
  title: string;
  case_id: string | null;
  created_at: string;
};

interface Props {
  chats: Chat[];
  activeChatId: string | null;
  userEmail: string;
  role: string | null;
  newChatLoading: boolean;
  onNewChat: () => void;
  onSelectChat: (chatId: string) => void;
  onDeleteChat: (chatId: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

function getInitials(email: string): string {
  const name = email.split("@")[0];
  const parts = name.split(/[._-]/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function displayName(email: string): string {
  return email.split("@")[0].replace(/[._-]/g, " ");
}

export default function ChatSidebar({
  chats,
  activeChatId,
  userEmail,
  role,
  newChatLoading,
  onNewChat,
  onSelectChat,
  onDeleteChat,
  collapsed,
  onToggleCollapsed,
}: Props) {
  const router = useRouter();
  const { signOut } = useAuth();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the profile menu when clicking outside
  useEffect(() => {
    if (!menuOpen) return;
    function onOutsideClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onOutsideClick);
    return () => document.removeEventListener("mousedown", onOutsideClick);
  }, [menuOpen]);

  const filteredChats = searchQuery.trim()
    ? chats.filter((c) => c.title.toLowerCase().includes(searchQuery.toLowerCase()))
    : chats;

  const initials = getInitials(userEmail);
  const name = displayName(userEmail);

  function NavBtn({
    onClick,
    icon,
    label,
    disabled,
  }: {
    onClick: () => void;
    icon: React.ReactNode;
    label: string;
    disabled?: boolean;
  }) {
    return (
      <button
        onClick={onClick}
        disabled={disabled}
        className="sidebar-nav-btn w-full flex items-center gap-3 px-3 py-2 rounded-lg
          text-[11px] font-bold uppercase tracking-widest
          disabled:opacity-40 disabled:cursor-not-allowed
          transition-all duration-150"
        style={{ color: "var(--sidebar-text)", opacity: disabled ? 0.4 : undefined }}
      >
        <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center opacity-60">
          {icon}
        </span>
        {label}
      </button>
    );
  }

  return (
    <aside
      className="themed-sidebar flex-shrink-0 flex flex-col h-full border-r overflow-hidden"
      style={{
        background: "var(--sidebar-bg)",
        borderColor: "var(--sidebar-border)",
        width: collapsed ? "52px" : "260px",
        transition: "width 0.25s cubic-bezier(0.16,1,0.3,1)",
      }}
    >
      {/* ── Collapse toggle strip (always visible) ────────── */}
      <div className={`flex-shrink-0 flex items-center border-b ${collapsed ? "justify-center px-0 py-3" : "justify-end px-2 py-2"}`}
        style={{ borderColor: "var(--sidebar-border)" }}>
        <button
          onClick={onToggleCollapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="w-8 h-8 rounded-lg flex items-center justify-center transition-all duration-150 hover:bg-black/5 dark:hover:bg-white/5"
          style={{ color: "var(--sidebar-text)", opacity: 0.5 }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
            {collapsed
              ? <><path d="M13 17l5-5-5-5"/><path d="M6 17l5-5-5-5"/></>
              : <><path d="M11 17l-5-5 5-5"/><path d="M18 17l-5-5 5-5"/></>
            }
          </svg>
        </button>
      </div>

      {/* ── TOP: Brand + Primary Actions ─────────────────── */}
      <div className={`p-3 space-y-0.5 ${collapsed ? "hidden" : ""}`}>
        {/* Brand */}
        <div className="flex items-center gap-2.5 px-3 py-2 mb-1">
          <HarveyLogo size={30} />
          <span className="font-black text-sm tracking-wider uppercase" style={{ color: "var(--sidebar-text)" }}>Harvey PK</span>
        </div>

        {/* New Chat */}
        <NavBtn
          onClick={onNewChat}
          disabled={newChatLoading}
          icon={
            newChatLoading ? (
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            )
          }
          label="New Chat"
        />

        {/* Search Chats */}
        <NavBtn
          onClick={() => { setSearchOpen((v) => !v); setSearchQuery(""); }}
          icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
          }
          label="Search Chats"
        />

        {/* Inline search box */}
        {searchOpen && (
          <div className="px-1 pt-1">
            <input
              autoFocus
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search chats…"
              className="w-full text-xs rounded-lg border border-slate-300 dark:border-slate-600
                bg-white dark:bg-slate-700
                px-3 py-2
                text-gray-800 dark:text-neutral-200
                placeholder-gray-400 dark:placeholder-neutral-600
                focus:outline-none focus:border-gray-300 dark:focus:border-neutral-700
                transition-colors duration-200"
            />
          </div>
        )}

        {/* Cases & Clients */}
        <NavBtn
          onClick={() => router.push("/clients")}
          icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
            </svg>
          }
          label="Cases & Clients"
        />

        {/* Admin-only links */}
        {role === "admin" && (
          <NavBtn
            onClick={() => router.push("/legal-corpus")}
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                <path d="M3 6l9-4 9 4v6c0 5.25-3.75 10.15-9 11.25C6.75 22.15 3 17.25 3 12V6z" />
              </svg>
            }
            label="Legal Corpus"
          />
        )}
      </div>

      {/* ── MIDDLE: Chat history ──────────────────────────── */}
      <div className={`flex-1 overflow-y-auto px-2 py-1 ${collapsed ? "hidden" : ""}`}>
        <p className="px-3 py-1.5 text-[9px] font-black uppercase tracking-[0.15em]"
          style={{ color: "var(--sidebar-text)", opacity: 0.5 }}>
          Chats
        </p>

        {filteredChats.length === 0 && (
          <p className="px-3 py-2 text-xs text-gray-400 dark:text-neutral-600">
            {searchQuery ? "No results found." : "No chats yet. Start one above."}
          </p>
        )}

        {filteredChats.map((chat) => (
          <div key={chat.id} className="group relative">
            <button
              onClick={() => onSelectChat(chat.id)}
              className={`w-full text-left px-3 py-2 text-xs rounded-lg transition-all duration-150 ${
                activeChatId === chat.id
                  ? "bg-black/10 dark:bg-white/10 font-semibold"
                  : "hover:bg-black/5 dark:hover:bg-white/5"
              }`}
              style={{ color: "var(--sidebar-text)" }}
            >
              <span className="block truncate pr-6">{chat.title}</span>
            </button>

            <button
              onClick={(e) => { e.stopPropagation(); onDeleteChat(chat.id); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-1.5 rounded text-gray-400 dark:text-neutral-600 hover:text-red-500 dark:hover:text-red-400 transition-all duration-200"
              aria-label="Delete chat"
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>

      {/* ── BOTTOM: Profile + Dropdown ────────────────────── */}
      <div className={`border-t border-slate-300 dark:border-slate-700 p-3 relative ${collapsed ? "hidden" : ""}`} ref={menuRef}>

        {/* ── Dropup menu ─────────────────────────────────── */}
        {menuOpen && (
          <div className="absolute bottom-full left-2 right-2 mb-2 bg-white dark:bg-slate-700 rounded-xl border border-slate-200 dark:border-slate-600 shadow-xl overflow-hidden z-50">

            {/* Account group */}
            <div className="py-1">
              {[
                { label: "Account Settings",      href: "/account",  icon: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" },
                { label: "Profile & Preferences", href: "/profile",  icon: "M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z" },
                { label: "Platform Settings",     href: "/platform", icon: "M4 6h16M4 12h16M4 18h16" },
              ].map(({ label, icon, href }) => (
                <button
                  key={label}
                  onClick={() => { setMenuOpen(false); router.push(href); }}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-xs text-gray-700 dark:text-neutral-300 hover:bg-slate-50 dark:hover:bg-slate-600 transition-colors duration-150"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 flex-shrink-0 text-gray-400 dark:text-neutral-500">
                    <path d={icon} />
                  </svg>
                  {label}
                </button>
              ))}
            </div>

            {/* Divider */}
            <div className="h-px bg-slate-200 dark:bg-slate-600 mx-3" />

            {/* Help */}
            <div className="py-1">
              <button
                onClick={() => { setMenuOpen(false); router.push("/help"); }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-xs text-gray-700 dark:text-neutral-300 hover:bg-slate-50 dark:hover:bg-slate-600 transition-colors duration-150"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 flex-shrink-0 text-gray-400 dark:text-neutral-500">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3M12 17h.01" />
                </svg>
                Help &amp; Support
              </button>
            </div>

            {/* Divider */}
            <div className="h-px bg-slate-200 dark:bg-slate-600 mx-3" />

            {/* Sign out */}
            <div className="py-1">
              <button
                onClick={async () => {
                  setMenuOpen(false);
                  await signOut();
                  router.push("/login");
                  router.refresh();
                }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors duration-150"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 flex-shrink-0">
                  <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                Sign Out
              </button>
            </div>
          </div>
        )}

        {/* ── Profile trigger ──────────────────────────────── */}
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className={`w-full flex items-center gap-3 px-2 py-2 rounded-lg transition-colors duration-200 ${
            menuOpen
              ? "bg-slate-300 dark:bg-slate-700"
              : "hover:bg-slate-300 dark:hover:bg-slate-700"
          }`}
        >
          <div className="w-8 h-8 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 flex items-center justify-center text-xs font-bold flex-shrink-0 select-none">
            {initials}
          </div>
          <div className="min-w-0 flex-1 text-left">
            <p className="text-xs font-medium text-gray-800 dark:text-neutral-200 truncate capitalize">{name}</p>
            <p className="text-[10px] text-gray-400 dark:text-neutral-600 capitalize">{role ?? "user"}</p>
          </div>
          {/* Chevron */}
          <svg
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className={`w-3.5 h-3.5 flex-shrink-0 text-gray-400 dark:text-neutral-600 transition-transform duration-200 ${menuOpen ? "rotate-180" : ""}`}
          >
            <polyline points="18 15 12 9 6 15" />
          </svg>
        </button>
      </div>

    </aside>
  );
}
