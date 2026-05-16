"use client";

export interface UploadedDocument {
  file_name:   string;
  totalChunks: number;
  scope:       string;
}

interface Props {
  documents:    UploadedDocument[];
  activeDocName: string | null;
  onSelectDoc:  (fileName: string) => void;
}

export default function DocumentBar({ documents, activeDocName, onSelectDoc }: Props) {
  if (documents.length === 0) return null;

  return (
    <div className="flex-shrink-0 border-b border-gray-200/60 dark:border-neutral-800
      bg-white/70 dark:bg-neutral-950/80 backdrop-blur-sm
      px-4 py-2 flex items-center gap-2 overflow-x-auto scale-in">
      <span className="text-[9px] font-bold uppercase tracking-widest text-gray-400 dark:text-neutral-600 flex-shrink-0 mr-1">
        Docs
      </span>

      {documents.map((doc) => {
        const active = activeDocName === doc.file_name;
        return (
          <button
            key={doc.file_name}
            onClick={() => onSelectDoc(doc.file_name)}
            title={`${doc.file_name} · ${doc.totalChunks} sections indexed`}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs flex-shrink-0 border transition-all duration-150 ${
              active
                ? "text-white border-transparent shadow-sm"
                : "bg-white dark:bg-neutral-900 border-gray-200 dark:border-neutral-800 text-gray-600 dark:text-neutral-300 hover:border-gray-300 dark:hover:border-neutral-700"
            }`}
            style={active ? { background: "var(--accent)", borderColor: "var(--accent)" } : undefined}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3 flex-shrink-0">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>

            <span className="max-w-[140px] truncate">{doc.file_name}</span>

            {doc.totalChunks > 0 && (
              <span className={`text-[10px] flex-shrink-0 tabular-nums ${active ? "text-white/70" : "text-gray-400 dark:text-neutral-600"}`}>
                {doc.totalChunks}
              </span>
            )}

            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${active ? "bg-green-300" : "bg-emerald-500"}`} />
          </button>
        );
      })}
    </div>
  );
}
