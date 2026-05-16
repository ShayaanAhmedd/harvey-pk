"use client";

export default function HelpContactForm() {
  return (
    <form onSubmit={(e) => e.preventDefault()} className="px-6 py-5 space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-neutral-500 mb-1">Full Name</label>
          <input
            type="text"
            placeholder="Your name"
            className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-neutral-500 transition-colors"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-neutral-500 mb-1">Email Address</label>
          <input
            type="email"
            placeholder="you@firm.com"
            className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-neutral-500 transition-colors"
          />
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-neutral-500 mb-1">Subject</label>
        <select className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-neutral-500 transition-colors">
          <option value="">Select a category</option>
          <option value="technical">Technical Issue</option>
          <option value="access">Access &amp; Permissions</option>
          <option value="feature">Feature Request</option>
          <option value="other">Other</option>
        </select>
      </div>
      <div>
        <label className="block text-xs font-medium text-neutral-500 mb-1">Message</label>
        <textarea
          rows={4}
          placeholder="Describe your issue or enquiry in detail…"
          className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-neutral-500 transition-colors resize-none"
        />
      </div>
      <div className="flex justify-end">
        <button
          type="submit"
          className="rounded-lg bg-neutral-700 hover:bg-neutral-600 px-5 py-2 text-sm font-medium text-neutral-100 transition-colors"
        >
          Submit Request
        </button>
      </div>
    </form>
  );
}
