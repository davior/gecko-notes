// Diagram (mind map / flow chart) data model + helpers shared by the diagram block,
// its interactive editor, the read-only shared render, and the exporters.
//
// The graph is stored inside a BlockNote `diagram` block's `data` prop as a JSON
// string (see blocks/diagramBlock.tsx). Node positions (x, y) are persisted so the
// static SVG preview and file exports render deterministically without re-running
// layout. Nodes may link to an external URL or to another note (noteId), the latter
// reusing the app's note-link + shared-view transform machinery.

import dagre from '@dagrejs/dagre'
import { MarkerType, Position } from '@xyflow/react'
import type { Edge, Node } from '@xyflow/react'

export type DiagramKind = 'mindmap' | 'flowchart'

export interface DiagramNode {
  id: string
  label: string
  x: number
  y: number
  url?: string
  noteId?: string
  noteTitle?: string
  color?: string
}

export interface DiagramEdge {
  id: string
  source: string
  target: string
  label?: string
}

export interface DiagramGraph {
  kind: DiagramKind
  nodes: DiagramNode[]
  edges: DiagramEdge[]
}

export const NODE_WIDTH = 172
export const NODE_HEIGHT = 48

// Data carried on a React Flow node so the custom node component can render the
// label + link affordance and (in the read-only view) a disabled state. The raw
// link fields ride along too so flowToGraph can fold state back losslessly.
export interface FlowNodeData extends Record<string, unknown> {
  label: string
  linkKind: 'url' | 'note' | null
  disabled: boolean
  url?: string
  noteId?: string
  noteTitle?: string
  color?: string
}

export type FlowNode = Node<FlowNodeData>

function uid(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
  }
}

export function newNodeId(): string {
  return `n-${uid()}`
}

export function newDiagramId(): string {
  return `d-${uid()}`
}

// A starter graph with a single root node so a freshly inserted diagram is never a
// blank canvas. Mind maps grow left-to-right from a central idea; flow charts flow
// top-to-bottom from a start step.
export function emptyGraph(kind: DiagramKind): DiagramGraph {
  return {
    kind,
    nodes: [
      {
        id: newNodeId(),
        label: kind === 'mindmap' ? 'Central idea' : 'Start',
        x: 0,
        y: 0,
      },
    ],
    edges: [],
  }
}

// Parse a stored `data` prop into a graph, tolerating empty/corrupt values.
export function parseGraph(data: string, kind: DiagramKind): DiagramGraph {
  if (!data || !data.trim()) return { kind, nodes: [], edges: [] }
  try {
    const parsed = JSON.parse(data) as Partial<DiagramGraph>
    return normalizeGraph({
      kind: parsed.kind === 'flowchart' || parsed.kind === 'mindmap' ? parsed.kind : kind,
      nodes: Array.isArray(parsed.nodes) ? (parsed.nodes as DiagramNode[]) : [],
      edges: Array.isArray(parsed.edges) ? (parsed.edges as DiagramEdge[]) : [],
    })
  } catch {
    return { kind, nodes: [], edges: [] }
  }
}

// Coerce a possibly-loose graph (e.g. one produced by the AI, which omits
// coordinates) into a well-formed DiagramGraph: fill missing ids/positions and drop
// edges that reference unknown nodes.
export function normalizeGraph(graph: Partial<DiagramGraph> & { kind: DiagramKind }): DiagramGraph {
  const nodes: DiagramNode[] = (graph.nodes ?? []).map((n, i) => ({
    id: n.id || newNodeId(),
    label: typeof n.label === 'string' ? n.label : '',
    x: Number.isFinite(n.x as number) ? (n.x as number) : (i % 4) * (NODE_WIDTH + 60),
    y: Number.isFinite(n.y as number) ? (n.y as number) : Math.floor(i / 4) * (NODE_HEIGHT + 60),
    ...(n.url ? { url: n.url } : {}),
    ...(n.noteId ? { noteId: n.noteId } : {}),
    ...(n.noteTitle ? { noteTitle: n.noteTitle } : {}),
    ...(n.color ? { color: n.color } : {}),
  }))
  const ids = new Set(nodes.map((n) => n.id))
  const edges: DiagramEdge[] = (graph.edges ?? [])
    .filter((e) => e && ids.has(e.source) && ids.has(e.target))
    .map((e) => ({
      id: e.id || `e-${e.source}-${e.target}`,
      source: e.source,
      target: e.target,
      ...(e.label ? { label: e.label } : {}),
    }))
  return { kind: graph.kind, nodes, edges }
}

// Assign positions with dagre. Mind maps lay out left-to-right (a tree radiating
// from the root); flow charts top-to-bottom. Used both by the "auto-layout" button
// and by the AI executor, whose emitted graphs carry no coordinates.
export function autoLayout(graph: DiagramGraph): DiagramGraph {
  if (graph.nodes.length === 0) return graph
  const g = new dagre.graphlib.Graph()
  g.setGraph({
    rankdir: graph.kind === 'mindmap' ? 'LR' : 'TB',
    nodesep: 40,
    ranksep: 70,
    marginx: 20,
    marginy: 20,
  })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of graph.nodes) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  for (const e of graph.edges) g.setEdge(e.source, e.target)
  dagre.layout(g)
  const nodes = graph.nodes.map((n) => {
    const p = g.node(n.id)
    // dagre positions are node centres; React Flow uses top-left origin.
    return p ? { ...n, x: Math.round(p.x - NODE_WIDTH / 2), y: Math.round(p.y - NODE_HEIGHT / 2) } : n
  })
  return { ...graph, nodes, edges: graph.edges }
}

function linkKindOf(n: DiagramNode): 'url' | 'note' | null {
  if (n.noteId) return 'note'
  if (n.url) return 'url'
  return null
}

// ─── React Flow <-> graph conversion ─────────────────────────────────────────

export function graphToFlow(
  graph: DiagramGraph,
  opts?: { disabledNoteIds?: Set<string> },
): { nodes: FlowNode[]; edges: Edge[] } {
  const horizontal = graph.kind === 'mindmap'
  const nodes: FlowNode[] = graph.nodes.map((n) => ({
    id: n.id,
    position: { x: n.x, y: n.y },
    type: 'diagramNode',
    data: {
      label: n.label,
      linkKind: linkKindOf(n),
      disabled: !!(n.noteId && opts?.disabledNoteIds?.has(n.noteId)),
      ...(n.url ? { url: n.url } : {}),
      ...(n.noteId ? { noteId: n.noteId } : {}),
      ...(n.noteTitle ? { noteTitle: n.noteTitle } : {}),
      ...(n.color ? { color: n.color } : {}),
    },
    sourcePosition: horizontal ? Position.Right : Position.Bottom,
    targetPosition: horizontal ? Position.Left : Position.Top,
  }))
  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
    markerEnd: { type: MarkerType.ArrowClosed },
  }))
  return { nodes, edges }
}

// Fold React Flow node/edge state back into a storable graph. All link metadata is
// carried on the flow node's data (see graphToFlow), so this is lossless.
export function flowToGraph(nodes: FlowNode[], edges: Edge[], kind: DiagramKind): DiagramGraph {
  const outNodes: DiagramNode[] = nodes.map((n) => ({
    id: n.id,
    label: (n.data?.label as string) ?? '',
    x: Math.round(n.position.x),
    y: Math.round(n.position.y),
    ...(n.data?.url ? { url: n.data.url as string } : {}),
    ...(n.data?.noteId ? { noteId: n.data.noteId as string } : {}),
    ...(n.data?.noteTitle ? { noteTitle: n.data.noteTitle as string } : {}),
    ...(n.data?.color ? { color: n.data.color as string } : {}),
  }))
  const outEdges: DiagramEdge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    ...(typeof e.label === 'string' && e.label ? { label: e.label } : {}),
  }))
  return { kind, nodes: outNodes, edges: outEdges }
}

// ─── Static SVG (inline preview + file exports) ──────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function truncateLabel(s: string, max = 22): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

// Deterministic SVG string for a graph, drawn from stored node positions. Used for
// the non-interactive inline preview inside the editable editor and embedded into
// HTML/PDF/Markdown/DOCX exports. Renders on a light background for consistent
// output regardless of the viewer's theme.
export function diagramToSVG(graph: DiagramGraph): string {
  const nodes = graph.nodes
  if (nodes.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80" viewBox="0 0 320 80"><rect width="320" height="80" fill="#f8fafc"/><text x="160" y="44" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#94a3b8">Empty diagram</text></svg>`
  }
  const pad = 24
  const minX = Math.min(...nodes.map((n) => n.x))
  const minY = Math.min(...nodes.map((n) => n.y))
  const maxX = Math.max(...nodes.map((n) => n.x + NODE_WIDTH))
  const maxY = Math.max(...nodes.map((n) => n.y + NODE_HEIGHT))
  const width = Math.max(120, maxX - minX + pad * 2)
  const height = Math.max(80, maxY - minY + pad * 2)
  const ox = pad - minX
  const oy = pad - minY
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const cx = (n: DiagramNode) => n.x + ox + NODE_WIDTH / 2
  const cy = (n: DiagramNode) => n.y + oy + NODE_HEIGHT / 2

  const edgeSvg = graph.edges
    .map((e) => {
      const s = byId.get(e.source)
      const t = byId.get(e.target)
      if (!s || !t) return ''
      return `<line x1="${cx(s)}" y1="${cy(s)}" x2="${cx(t)}" y2="${cy(t)}" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#arrow)"/>`
    })
    .join('')

  const nodeSvg = nodes
    .map((n) => {
      const linked = !!(n.noteId || n.url)
      const fill = n.color || (linked ? '#eff6ff' : '#ffffff')
      const stroke = linked ? '#3b82f6' : '#cbd5e1'
      const textColor = linked ? '#1d4ed8' : '#0f172a'
      return `<g><rect x="${n.x + ox}" y="${n.y + oy}" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/><text x="${n.x + ox + NODE_WIDTH / 2}" y="${n.y + oy + NODE_HEIGHT / 2 + 4}" text-anchor="middle" font-family="sans-serif" font-size="13" fill="${textColor}">${escapeXml(truncateLabel(n.label || 'Untitled'))}</text></g>`
    })
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><rect width="${width}" height="${height}" fill="#f8fafc"/>${edgeSvg}${nodeSvg}</svg>`
}

// A base64 data URI for the graph's SVG — embeddable in an <img> for HTML/PDF/MD
// exports.
export function diagramToDataUri(graph: DiagramGraph): string {
  const svg = diagramToSVG(graph)
  // Unicode-safe base64 (btoa alone throws on multi-byte characters).
  const bytes = new TextEncoder().encode(svg)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return `data:image/svg+xml;base64,${btoa(bin)}`
}

// ─── AI context ──────────────────────────────────────────────────────────────

// A compact, human-readable listing of the diagrams embedded in a note's blocks, so
// the AI assistant can see them (they're invisible in the Markdown it's given) and
// target one with edit_diagram. Returns '' when the note has no diagrams.
export function describeDiagrams(blocks: unknown[]): string {
  const out: string[] = []
  const walk = (list: unknown[]) => {
    for (const b of list) {
      const rec = b as Record<string, unknown> | null
      if (!rec || typeof rec !== 'object') continue
      if (rec.type === 'diagram') {
        const props = (rec.props as Record<string, unknown>) || {}
        const id = String(props.diagramId ?? '')
        const kind = String(props.kind ?? 'mindmap')
        const graph = parseGraph(String(props.data ?? ''), kind === 'flowchart' ? 'flowchart' : 'mindmap')
        const nodeLines = graph.nodes.map((n) => {
          const link = n.noteId ? ` -> note ${n.noteId}` : n.url ? ` -> url ${n.url}` : ''
          return `${n.id}:"${n.label}"${link}`
        })
        const edgeLines = graph.edges.map((e) => `${e.source}->${e.target}${e.label ? ` (${e.label})` : ''}`)
        out.push(
          `[diagram ${id}] kind=${kind}\n  nodes: ${nodeLines.join('; ') || '(none)'}\n  edges: ${edgeLines.join('; ') || '(none)'}`,
        )
      }
      if (Array.isArray(rec.children)) walk(rec.children as unknown[])
    }
  }
  walk(blocks)
  return out.join('\n')
}

// ─── Auto-open registry ──────────────────────────────────────────────────────
// A freshly slash-inserted diagram should open its editor immediately. The block
// can't be told to open via props (props persist in the note), so the insert helper
// records the new diagram's id here and the block consumes it once on mount.

const pendingOpen = new Set<string>()

export function markPendingOpen(diagramId: string): void {
  pendingOpen.add(diagramId)
}

export function consumePendingOpen(diagramId: string): boolean {
  if (pendingOpen.has(diagramId)) {
    pendingOpen.delete(diagramId)
    return true
  }
  return false
}
