"use client";

// CreateClientForm — shown only to admin and lawyer roles.
// Calls POST /api/clients and refreshes the server component
// (the clients page list) via router.refresh() on success.

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function CreateClientForm() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const router = useRouter();

  function handleClose() {
    setOpen(false);
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const formData = new FormData(e.currentTarget);

    const payload = {
      full_name: formData.get("full_name"),
      cnic: formData.get("cnic") || null,
      phone: formData.get("phone") || null,
      email: formData.get("email") || null,
      address: formData.get("address") || null,
      client_type: formData.get("client_type"),
      contact_name: formData.get("contact_name") || null,
    };

    const res = await fetch("/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok) {
      setError(data.error ?? "Failed to create client.");
      setLoading(false);
      return;
    }

    // Trigger a server-side re-fetch so the list updates without a full reload
    router.refresh();
    handleClose();
    setLoading(false);
  }

  // ── Toggle button (closed state) ─────────────────────────────
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-md bg-black px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800 transition-colors"
      >
        + New Client
      </button>
    );
  }

  // ── Inline form (open state) ──────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-lg bg-white rounded-lg shadow-xl p-6">

        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-gray-900">New Client</h2>
          <button
            type="button"
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">

          {/* Client type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Client type
            </label>
            <select
              name="client_type"
              defaultValue="individual"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
            >
              <option value="individual">Individual</option>
              <option value="company">Company</option>
            </select>
          </div>

          {/* Full name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Full name <span className="text-red-500">*</span>
            </label>
            <input
              name="full_name"
              type="text"
              required
              placeholder="Muhammad Ali Khan"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
            />
          </div>

          {/* Contact name (companies) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Contact person{" "}
              <span className="text-gray-400 font-normal">(companies only)</span>
            </label>
            <input
              name="contact_name"
              type="text"
              placeholder="Primary contact name"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
            />
          </div>

          {/* CNIC */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              CNIC{" "}
              <span className="text-gray-400 font-normal">00000-0000000-0</span>
            </label>
            <input
              name="cnic"
              type="text"
              placeholder="35202-1234567-9"
              pattern="\d{5}-\d{7}-\d"
              title="Format: 00000-0000000-0"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
            />
          </div>

          {/* Phone + Email in one row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Phone
              </label>
              <input
                name="phone"
                type="tel"
                placeholder="+92 300 0000000"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Email
              </label>
              <input
                name="email"
                type="email"
                placeholder="client@email.com"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
              />
            </div>
          </div>

          {/* Address */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Address
            </label>
            <input
              name="address"
              type="text"
              placeholder="House #1, Street 2, Lahore"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
            />
          </div>

          {/* Error */}
          {error && (
            <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
              {error}
            </p>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="rounded-md bg-black px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? "Creating…" : "Create client"}
            </button>
          </div>

        </form>
      </div>
    </div>
  );
}
