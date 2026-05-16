// Root layout — minimal shell.
//
// Provides <html> + <body> and wraps the entire app in <AuthProvider>
// so every Client Component can call useAuth().

import "./globals.css";
import { AuthProvider } from "@/context/AuthContext";

// ── Inline theme loader — runs before first paint to prevent FOUC ──────────
const THEME_LOADER = `
(function(){
  var FONTS={'Inter':"'Inter',system-ui,sans-serif",'Poppins':"'Poppins',sans-serif",'Roboto':"'Roboto',sans-serif",'Montserrat':"'Montserrat',sans-serif",'Playfair Display':"'Playfair Display',Georgia,serif",'Georgia':"Georgia,serif",'system-ui':"system-ui,-apple-system,sans-serif"};
  try {
    var p = JSON.parse(localStorage.getItem('harvey_appearance') || '{}');
    var r = document.documentElement;
    // Helper: brightness from hex
    function bright(h){var n=parseInt(h.replace('#',''),16);return((n>>16)*299+((n>>8)&255)*587+(n&255)*114)/1000;}
    function contrast(h){return bright(h)<128?'#ffffff':'#111827';}
    function rgbStr(h){var n=parseInt(h.replace('#',''),16);return ((n>>16)&255)+', '+((n>>8)&255)+', '+(n&255);}

    if (p.accentColor) {
      r.style.setProperty('--accent', p.accentColor);
      r.style.setProperty('--accent-rgb', rgbStr(p.accentColor));
    }
    if (p.sidebarColor) {
      r.style.setProperty('--sidebar-bg', p.sidebarColor);
      r.style.setProperty('--sidebar-text', contrast(p.sidebarColor));
    }
    if (p.sidebarBorder) r.style.setProperty('--sidebar-border', p.sidebarBorder);
    if (p.canvasBg) {
      r.style.setProperty('--canvas-bg', p.canvasBg);
      if (!p.textColor)     r.style.setProperty('--text-color',      contrast(p.canvasBg));
      if (!p.textSecondary) r.style.setProperty('--text-secondary',  bright(p.canvasBg)<128?'#9ca3af':'#6b7280');
      if (!p.chatTextColor) r.style.setProperty('--chat-text-color', contrast(p.canvasBg));
    }
    if (p.userMsgBg) {
      r.style.setProperty('--user-msg-bg',   p.userMsgBg);
      r.style.setProperty('--user-msg-text', p.userMsgText || contrast(p.userMsgBg));
    }
    if (p.textColor)     r.style.setProperty('--text-color',      p.textColor);
    if (p.textSecondary) r.style.setProperty('--text-secondary',  p.textSecondary);
    if (p.chatTextColor) r.style.setProperty('--chat-text-color', p.chatTextColor);
    if (p.chatBgStyle)   r.setAttribute('data-chat-bg', p.chatBgStyle);
    if (p.fontFamily && FONTS[p.fontFamily]) r.style.setProperty('--font-family', FONTS[p.fontFamily]);
    if (p.fontSize) {
      var fsMap = {sm:'13px',md:'14px',lg:'15px',xl:'16px'};
      r.style.setProperty('--font-size-base', fsMap[p.fontSize] || '14px');
    }
    if (p.animSpeed) {
      var dur = {fast:0.5, normal:1, slow:1.8}[p.animSpeed] || 1;
      r.style.setProperty('--dur-fast', Math.round(150*dur)+'ms');
      r.style.setProperty('--dur-mid',  Math.round(250*dur)+'ms');
      r.style.setProperty('--dur-slow', Math.round(400*dur)+'ms');
    }
  } catch(e) {}
})();
`.trim();

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Google Fonts — preconnect for speed */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Poppins:wght@300;400;500;600;700&family=Roboto:wght@300;400;500;700&family=Montserrat:wght@300;400;500;600;700&family=Playfair+Display:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        {/* Inline theme loader — blocks until CSS vars are applied */}
        <script dangerouslySetInnerHTML={{ __html: THEME_LOADER }} />
      </head>
      <body className="min-h-screen antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
