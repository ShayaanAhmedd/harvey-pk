// Root layout — minimal shell.
//
// Provides <html> + <body> and wraps the entire app in <AuthProvider>
// so every Client Component can call useAuth().
//
// Route groups:
//   (workspace) — authenticated workspace + CRUD pages  (auth)      — login page (no sidebar, no auth guard)

import "./globals.css";
import { AuthProvider } from "@/context/AuthContext";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100 transition-colors duration-300">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
