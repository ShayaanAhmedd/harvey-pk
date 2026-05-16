"use client";

// app/(workspace)/section-graph/[act]/[section]/page.tsx
//
// Section Relationship Graph — radial SVG visualization of a statutory
// provision's connections in the legal knowledge graph.
//
// URL params:
//   act     — URL-encoded act name  (e.g. "Pakistan%20Penal%20Code")
//   section — section number        (e.g. "302")
//
// Graph layout: center node (selected section) with connected nodes orbiting
// at a fixed radius, grouped into arcs by type:
//   Cases       — top arc    — violet
//   Sections    — right arc  — blue
//   Amendments  — bottom arc — amber
//
// Click behaviour:
//   section node  → navigate to /section-graph/[act]/[section]
//   case node     → open side panel (case intelligence needs a chatId)

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";

// ── API types ─────────────────────────────────────────────────────────────────

interface RelationshipEntry {
  name:              string;
  entity_type:       string;
  relationship_type: string;
  direction:         "outgoing" | "incoming";
  weight:            number;
}

interface SectionGraphResponse {
  section: string;
  relationships: {
    interpreted_by_cases: RelationshipEntry[];
    cited_sections:       RelationshipEntry[];
    amendments:           RelationshipEntry[];
    related_sections:     RelationshipEntry[];
  };
}

// ── Graph types ───────────────────────────────────────────────────────────────

type NodeType = "center" | "case" | "section" | "amendment";

interface GraphNode {
  id:               string;
  label:            string;  // truncated display label
  fullName:         string;  // tooltip / panel
  type:             NodeType;
  relationshipType: string;
  direction:        "outgoing" | "incoming" | "";
  x: number;
  y: number;
}

interface GraphEdge {
  sourceId: string;
  targetId: string;
  label:    string;
}

// ── Layout constants ──────────────────────────────────────────────────────────

const SVG_W     = 900;
const SVG_H     = 600;
const CX        = SVG_W / 2;
const CY        = SVG_H / 2;
const ORBIT_R   = 230;
const CENTER_R  = 36;
const NODE_R    = 22;
const MAX_NODES = 40;   // max peer nodes rendered

// Arc boundaries (radians). 0 = 3 o'clock, increases clockwise.
// Cases:      ~top      (−π·0.9 → π·0.1)
// Sections:   ~right    (π·0.1  → π·0.7)
// Amendments: ~bottom   (π·0.7  → π·1.1)
const ARCS: Record<Exclude<NodeType, "center">, { start: number; end: number }> = {
  case:      { start: -Math.PI * 0.9, end:  Math.PI * 0.1 },
  section:   { start:  Math.PI * 0.1, end:  Math.PI * 0.7 },
  amendment: { start:  Math.PI * 0.7, end:  Math.PI * 1.1 },
};

// Node visual styles
const NODE_STYLES: Record<NodeType, { fill: string; stroke: string; text: string }> = {
  center:    { fill: "#e2e8f0", stroke: "#94a3b8", text: "#0f172a" },
  case:      { fill: "#6d28d9", stroke: "#a78bfa", text: "#ede9fe" },
  section:   { fill: "#1d4ed8", stroke: "#60a5fa", text: "#dbeafe" },
  amendment: { fill: "#b45309", stroke: "#fcd34d", text: "#fef3c7" },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function trunc(str: string, len: number): string {
  return str.length > len ? str.slice(0, len - 1) + "…" : str;
}

/** Parse a compound section key: "Pakistan Penal Code:::302" */
function parseSectionKey(name: string): { act: string; section: string } | null {
  const i = name.indexOf(":::");
  if (i === -1) return null;
  return { act: name.slice(0, i).trim(), section: name.slice(i + 3).trim() };
}

/** Short display label for a graph node */
function nodeLabel(entry: RelationshipEntry, type: NodeType): string {
  if (type === "section") {
    const parsed = parseSectionKey(entry.name);
    return parsed ? `§${parsed.section}` : trunc(entry.name, 10);
  }
  return trunc(entry.name, 13);
}

/** Compute (x, y) for the idx-th node out of count in a given arc */
function arcPosition(idx: number, count: number, arc: { start: number; end: number }) {
  const angle =
    count === 1
      ? (arc.start + arc.end) / 2
      : arc.start + (idx / (count - 1)) * (arc.end - arc.start);
  return {
    x: CX + ORBIT_R * Math.cos(angle),
    y: CY + ORBIT_R * Math.sin(angle),
  };
}

// ── Build graph data from API response ───────────────────────────────────────

function buildGraph(response: SectionGraphResponse): { nodes: GraphNode[]; edges: GraphEdge[] } {
  type Entry = { rel: RelationshipEntry; type: Exclude<NodeType, "center"> };

  // Merge all buckets, label type, then cap at MAX_NODES
  const raw: Entry[] = [
    ...response.relationships.interpreted_by_cases.map((r) => ({ rel: r, type: "case"      as const })),
    ...response.relationships.cited_sections      .map((r) => ({ rel: r, type: "section"   as const })),
    ...response.relationships.amendments          .map((r) => ({ rel: r, type: "amendment" as const })),
    ...response.relationships.related_sections    .map((r) => ({ rel: r, type: "section"   as const })),
  ].slice(0, MAX_NODES);

  // Deduplicate by name — keep first occurrence
  const seen = new Set<string>();
  const entries: Entry[] = [];
  for (const e of raw) {
    if (!seen.has(e.rel.name)) {
      seen.add(e.rel.name);
      entries.push(e);
    }
  }

  // Count per type for arc position computation
  const counts = { case: 0, section: 0, amendment: 0 };
  for (const e of entries) counts[e.type]++;

  // Index trackers per type
  const idx = { case: 0, section: 0, amendment: 0 };

  const centerNode: GraphNode = {
    id:               "center",
    label:            response.section.includes("§")
                        ? `§${response.section.split("§")[1] ?? response.section}`
                        : response.section,
    fullName:         response.section,
    type:             "center",
    relationshipType: "",
    direction:        "",
    x: CX,
    y: CY,
  };

  const nodes: GraphNode[] = [centerNode];
  const edges: GraphEdge[] = [];

  entries.forEach((e, i) => {
    const type   = e.type;
    const pos    = arcPosition(idx[type], counts[type], ARCS[type]);
    idx[type]++;

    const id = `node-${i}`;
    nodes.push({
      id,
      label:            nodeLabel(e.rel, type),
      fullName:         e.rel.name,
      type,
      relationshipType: e.rel.relationship_type,
      direction:        e.rel.direction,
      x: pos.x,
      y: pos.y,
    });
    edges.push({ sourceId: "center", targetId: id, label: e.rel.relationship_type });
  });

  return { nodes, edges };
}

// ── Subcomponents ─────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
      <div className="text-center space-y-4">
        <div className="w-10 h-10 border-2 border-neutral-700 border-t-violet-500 rounded-full animate-spin mx-auto" />
        <p className="text-neutral-500 text-sm">Loading graph…</p>
      </div>
    </div>
  );
}

function ErrorState({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
      <div className="bg-[#111111] border border-red-900/40 rounded-xl p-8 max-w-sm text-center space-y-3">
        <p className="text-red-400 font-medium text-sm">Failed to load graph</p>
        <p className="text-neutral-500 text-xs">{message}</p>
        <button
          onClick={onBack}
          className="mt-2 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs rounded-lg transition-colors"
        >
          Go back
        </button>
      </div>
    </div>
  );
}

function EmptyGraph({ actName, sectionNum }: { actName: string; sectionNum: string }) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="w-16 h-16 rounded-full border-2 border-dashed border-neutral-800 flex items-center justify-center mx-auto">
          <span className="text-neutral-700 text-2xl">∅</span>
        </div>
        <p className="text-neutral-400 text-sm">No relationships found</p>
        <p className="text-neutral-600 text-xs max-w-xs">
          {actName} §{sectionNum} has no entries in the knowledge graph yet.
        </p>
      </div>
    </div>
  );
}

interface NodeInfoPanelProps {
  node:    GraphNode;
  onClose: () => void;
}

function NodeInfoPanel({ node, onClose }: NodeInfoPanelProps) {
  const typeLabel =
    node.type === "case" ? "Case" :
    node.type === "amendment" ? "Amendment" : "Section";

  const badgeClass =
    node.type === "case"
      ? "bg-violet-900/50 text-violet-300"
      : node.type === "amendment"
      ? "bg-amber-900/50 text-amber-300"
      : "bg-blue-900/50 text-blue-300";

  return (
    <aside className="w-72 shrink-0 border-l border-neutral-800 bg-[#0d0d0d] p-5 flex flex-col overflow-y-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${badgeClass}`}>
          {typeLabel}
        </span>
        <button
          onClick={onClose}
          className="text-neutral-600 hover:text-neutral-300 text-xl leading-none ml-2 shrink-0"
          aria-label="Close panel"
        >
          ×
        </button>
      </div>

      {/* Name */}
      <p className="text-neutral-200 text-sm font-medium leading-snug break-words mb-5">
        {node.fullName}
      </p>

      {/* Meta */}
      <dl className="space-y-3 text-xs">
        <div>
          <dt className="text-neutral-600 mb-0.5">Relationship type</dt>
          <dd className="text-neutral-300 font-mono bg-neutral-900 px-2 py-1 rounded">
            {node.relationshipType || "—"}
          </dd>
        </div>
        <div>
          <dt className="text-neutral-600 mb-0.5">Direction</dt>
          <dd className="text-neutral-300">{node.direction || "—"}</dd>
        </div>
      </dl>

      {/* Actions */}
      {node.type === "case" && (
        <div className="mt-auto pt-5 border-t border-neutral-800">
          <p className="text-neutral-600 text-xs mb-2">Case actions</p>
          <button
            onClick={() =>
              alert(
                "Open this case in a chat to access full case intelligence:\n\n" +
                  node.fullName
              )
            }
            className="w-full px-3 py-2 bg-violet-900/30 hover:bg-violet-900/50 border border-violet-800/40 text-violet-300 text-xs rounded-lg transition-colors text-left"
          >
            View case intelligence →
          </button>
        </div>
      )}
    </aside>
  );
}

// ── SVG Graph ─────────────────────────────────────────────────────────────────

interface SvgGraphProps {
  nodes:    GraphNode[];
  edges:    GraphEdge[];
  selected: GraphNode | null;
  onNode:   (node: GraphNode) => void;
}

function SvgGraph({ nodes, edges, selected, onNode }: SvgGraphProps) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  return (
    <svg
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      className="w-full max-w-4xl h-auto"
      style={{ maxHeight: "calc(100vh - 140px)" }}
    >
      <defs>
        {/* Soft glow for center node */}
        <filter id="sg-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        {/* Arrowhead marker */}
        <marker
          id="sg-arrow"
          markerWidth="6"
          markerHeight="6"
          refX="5"
          refY="3"
          orient="auto"
        >
          <path d="M0,0 L0,6 L6,3 z" fill="#52525b" />
        </marker>
      </defs>

      {/* ── Edges ── */}
      {edges.map((edge, i) => {
        const src = nodeMap.get(edge.sourceId);
        const tgt = nodeMap.get(edge.targetId);
        if (!src || !tgt) return null;

        const dx  = tgt.x - src.x;
        const dy  = tgt.y - src.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const ux  = dx / len;
        const uy  = dy / len;

        // Start at edge of center circle, end before target circle
        const x1 = src.x + ux * (CENTER_R + 3);
        const y1 = src.y + uy * (CENTER_R + 3);
        const x2 = tgt.x - ux * (NODE_R + 4);
        const y2 = tgt.y - uy * (NODE_R + 4);

        // Label midpoint — nudge slightly off-line to avoid overlap
        const mx   = (x1 + x2) / 2 - uy * 7;
        const my   = (y1 + y2) / 2 + ux * 7;

        return (
          <g key={i}>
            <line
              x1={x1} y1={y1}
              x2={x2} y2={y2}
              stroke="#3f3f46"
              strokeWidth="1.5"
              markerEnd="url(#sg-arrow)"
            />
            <text
              x={mx}
              y={my}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize="8.5"
              fill="#71717a"
              style={{ userSelect: "none", pointerEvents: "none" }}
            >
              {edge.label}
            </text>
          </g>
        );
      })}

      {/* ── Nodes ── */}
      {nodes.map((node) => {
        const s          = NODE_STYLES[node.type];
        const r          = node.type === "center" ? CENTER_R : NODE_R;
        const isCenter   = node.type === "center";
        const isSelected = selected?.id === node.id;
        const clickable  = !isCenter;

        return (
          <g
            key={node.id}
            transform={`translate(${node.x},${node.y})`}
            onClick={() => clickable && onNode(node)}
            style={{ cursor: clickable ? "pointer" : "default" }}
          >
            <title>
              {node.fullName}
              {node.relationshipType ? ` — ${node.relationshipType}` : ""}
            </title>

            {/* Selection ring */}
            {isSelected && (
              <circle
                r={r + 7}
                fill="none"
                stroke={s.stroke}
                strokeWidth="1.5"
                strokeDasharray="4 3"
                opacity="0.7"
              />
            )}

            {/* Hover ring — pure CSS trick via stroke on a transparent circle */}
            {clickable && (
              <circle
                r={r + 5}
                fill="transparent"
                stroke="transparent"
                strokeWidth="0"
                className="hover-ring"
              />
            )}

            {/* Main circle */}
            <circle
              r={r}
              fill={s.fill}
              stroke={s.stroke}
              strokeWidth={isCenter ? 2.5 : 1.5}
              filter={isCenter ? "url(#sg-glow)" : undefined}
            />

            {/* Label — single line for peer nodes, wrapped for center */}
            {isCenter ? (
              <>
                <text
                  textAnchor="middle"
                  y="-5"
                  fontSize="12"
                  fontWeight="700"
                  fill={s.text}
                  style={{ userSelect: "none", pointerEvents: "none" }}
                >
                  {node.label}
                </text>
                <text
                  textAnchor="middle"
                  y="9"
                  fontSize="8"
                  fill="#475569"
                  style={{ userSelect: "none", pointerEvents: "none" }}
                >
                  section
                </text>
              </>
            ) : (
              <text
                textAnchor="middle"
                dominantBaseline="central"
                fontSize="8.5"
                fontWeight="500"
                fill={s.text}
                style={{ userSelect: "none", pointerEvents: "none" }}
              >
                {node.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SectionGraphPage() {
  const params     = useParams<{ act: string; section: string }>();
  const router     = useRouter();
  const actName    = decodeURIComponent(params.act    ?? "");
  const sectionNum = decodeURIComponent(params.section ?? "");

  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);
  const [response, setResponse] = useState<SectionGraphResponse | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);

  // Fetch on param change
  useEffect(() => {
    if (!actName || !sectionNum) return;
    setLoading(true);
    setError(null);
    setResponse(null);
    setSelected(null);

    fetch("/api/section-graph", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ act_name: actName, section_number: sectionNum }),
    })
      .then(async (res) => {
        if (res.status === 401) throw new Error("Unauthorized — please sign in.");
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<SectionGraphResponse>;
      })
      .then(setResponse)
      .catch((err) => setError(err instanceof Error ? err.message : "Unknown error"))
      .finally(() => setLoading(false));
  }, [actName, sectionNum]);

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      if (node.type === "section") {
        const parsed = parseSectionKey(node.fullName);
        if (parsed) {
          router.push(
            `/section-graph/${encodeURIComponent(parsed.act)}/${encodeURIComponent(parsed.section)}`
          );
        }
        return;
      }
      // Case or amendment — toggle info panel
      setSelected((prev) => (prev?.id === node.id ? null : node));
    },
    [router]
  );

  // ── Early exits ────────────────────────────────────────────────────────────
  if (loading) return <Spinner />;
  if (error)   return <ErrorState message={error} onBack={() => router.back()} />;
  if (!response) return null;

  const { nodes, edges } = buildGraph(response);
  const isEmpty = nodes.length <= 1;

  const totalRels =
    response.relationships.interpreted_by_cases.length +
    response.relationships.cited_sections.length +
    response.relationships.amendments.length +
    response.relationships.related_sections.length;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-neutral-100 flex flex-col">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="border-b border-neutral-800 px-6 py-4 flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-base font-semibold text-neutral-100">{response.section}</h1>
          <p className="text-xs text-neutral-600 mt-0.5">Statutory relationship graph</p>
        </div>

        <div className="flex items-center gap-4">
          {/* Legend */}
          <div className="hidden md:flex items-center gap-4 text-xs text-neutral-500">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-violet-600 shrink-0" />
              Cases
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-blue-700 shrink-0" />
              Sections
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-amber-700 shrink-0" />
              Amendments
            </span>
          </div>

          <button
            onClick={() => router.back()}
            className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-neutral-200 text-xs rounded-lg transition-colors"
          >
            ← Back
          </button>
        </div>
      </header>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden min-h-0">

        {/* Graph canvas */}
        <div className="flex-1 flex items-center justify-center p-4 overflow-hidden">
          {isEmpty ? (
            <EmptyGraph actName={actName} sectionNum={sectionNum} />
          ) : (
            <SvgGraph
              nodes={nodes}
              edges={edges}
              selected={selected}
              onNode={handleNodeClick}
            />
          )}
        </div>

        {/* Info panel (conditional) */}
        {selected && (
          <NodeInfoPanel node={selected} onClose={() => setSelected(null)} />
        )}
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      {!isEmpty && (
        <footer className="border-t border-neutral-800 px-6 py-2.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-neutral-600 shrink-0">
          <span className="text-neutral-500">{totalRels} relationship{totalRels !== 1 ? "s" : ""}</span>
          <span>{response.relationships.interpreted_by_cases.length} cases</span>
          <span>
            {response.relationships.cited_sections.length + response.relationships.related_sections.length} sections
          </span>
          <span>{response.relationships.amendments.length} amendments</span>
          {totalRels > MAX_NODES && (
            <span className="text-amber-600/80">Showing first {MAX_NODES} nodes</span>
          )}
          <span className="ml-auto text-neutral-700">
            Click a section node to drill down · Click a case node for details
          </span>
        </footer>
      )}
    </div>
  );
}
