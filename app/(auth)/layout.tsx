// Auth layout — wraps /login (and any future /register, /reset-password).
// Intentionally has no sidebar; just a full-screen centered container.
// Styling is minimal — Phase 3 will add the visual design.

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50">
      {children}
    </main>
  );
}
