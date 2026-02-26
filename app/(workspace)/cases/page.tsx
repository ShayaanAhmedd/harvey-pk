import Link from "next/link";

export default function CasesPage() {
  return (
    <div className="min-h-screen bg-gray-100 p-10">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 mb-6"
      >
        ← Back to workspace
      </Link>
      <h1 className="text-2xl font-bold text-gray-900">Cases</h1>
      <p className="text-sm text-gray-500 mt-1">Cases module coming soon.</p>
    </div>
  );
}
