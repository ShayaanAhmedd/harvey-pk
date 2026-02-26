import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import CreateClientForm from "@/components/clients/CreateClientForm";

type Client = {
  id: string;
  full_name: string;
  cnic: string | null;
  phone: string | null;
  email: string | null;
  client_type: "individual" | "company";
  contact_name: string | null;
  created_at: string;
};

export default async function ClientsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  const role = roleRow?.role ?? null;
  const canCreate = role === "admin" || role === "lawyer";

  const { data: clients, error } = await supabase
    .from("clients")
    .select("id, full_name, cnic, phone, email, client_type, contact_name, created_at")
    .order("created_at", { ascending: false });

  return (
    <div className="min-h-screen bg-gray-100 p-10">
      {/* ── Back link ───────────────────────────────────────────── */}
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 mb-6"
      >
        ← Back to workspace
      </Link>

      {/* ── Page header ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Clients</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {clients?.length ?? 0} client{clients?.length !== 1 ? "s" : ""}
          </p>
        </div>
        {canCreate && <CreateClientForm />}
      </div>

      {/* ── Error state ─────────────────────────────────────────── */}
      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 mb-4">
          Failed to load clients: {error.message}
        </div>
      )}

      {/* ── Empty state ─────────────────────────────────────────── */}
      {!error && (!clients || clients.length === 0) && (
        <div className="rounded-lg border border-dashed border-gray-300 px-6 py-12 text-center bg-white">
          <p className="text-gray-500 text-sm">No clients yet.</p>
          {canCreate && (
            <p className="text-gray-400 text-xs mt-1">
              Use the "New Client" button to add the first one.
            </p>
          )}
        </div>
      )}

      {/* ── Client table ────────────────────────────────────────── */}
      {clients && clients.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Name</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Type</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">CNIC</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Phone</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Email</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(clients as Client[]).map((client) => (
                <tr
                  key={client.id}
                  className="relative hover:bg-indigo-50 transition-colors group"
                >
                  <td className="px-4 py-3">
                    {/* Full-row link — absolutely positioned over the entire <tr> */}
                    <Link href={`/clients/${client.id}`} className="absolute inset-0" aria-label={`Open ${client.full_name}`} />
                    <div className="font-medium text-gray-900 group-hover:text-indigo-700 transition-colors">
                      {client.full_name}
                    </div>
                    {client.contact_name && (
                      <div className="text-xs text-gray-400">c/o {client.contact_name}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize bg-gray-100 text-gray-700">
                      {client.client_type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600 font-mono text-xs">
                    {client.cnic ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{client.phone ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-600">{client.email ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
