// Diagram (mind map / flow chart / etc.) helpers built on Mermaid.js. Notes store the
// raw Mermaid source string inside a `diagram` BlockNote block; this module is the one
// place that turns that source into a sanitized SVG, used by every render site (the
// inline editor preview, the editor modal's live preview, the read-only shared/history
// render, and every file exporter).
//
// Security: mermaid.render() returns a raw SVG string that must be inserted into the DOM
// via dangerouslySetInnerHTML. Diagram source can be authored by any note owner (or the AI
// on their behalf) and rendered in the PUBLIC, unauthenticated shared view and in
// standalone exported HTML files, so it's a real stored-XSS surface unless sanitized.
// renderMermaid() is the single choke point: no caller ever touches mermaid's raw output.

export type DiagramKind =
  | 'flowchart' | 'sequence' | 'class' | 'state' | 'er' | 'gantt' | 'pie' | 'timeline' | 'mindmap' | 'other'

// Which Mermaid diagram kinds render `click <id> href "..."` as an actual clickable
// element. Confirmed: flowchart/class/state support it; mindmap does not (open upstream
// limitation, https://github.com/mermaid-js/mermaid/issues/4099). The rest are believed
// unsupported — this is the one place to correct if a kind turns out to behave differently.
export const KIND_SUPPORTS_LINKS: Record<DiagramKind, boolean> = {
  flowchart: true,
  class: true,
  state: true,
  sequence: false,
  er: false,
  gantt: false,
  pie: false,
  timeline: false,
  mindmap: false,
  other: false,
}

export const DIAGRAM_KIND_LABELS: Record<DiagramKind, string> = {
  flowchart: 'Flow chart',
  sequence: 'Sequence diagram',
  class: 'Class diagram',
  state: 'State diagram',
  er: 'ER diagram',
  gantt: 'Gantt chart',
  pie: 'Pie chart',
  timeline: 'Timeline',
  mindmap: 'Mind map',
  other: 'Diagram',
}

const MERMAID_STARTERS: Record<DiagramKind, string> = {
  flowchart: 'flowchart TD\n    A[Start] --> B[Next step]',
  sequence: 'sequenceDiagram\n    Alice->>Bob: Hello Bob\n    Bob-->>Alice: Hi Alice',
  class: 'classDiagram\n    class Animal {\n        +String name\n        +makeSound()\n    }\n    class Dog\n    Animal <|-- Dog',
  state: 'stateDiagram-v2\n    [*] --> Idle\n    Idle --> Running\n    Running --> [*]',
  er: 'erDiagram\n    CUSTOMER ||--o{ ORDER : places\n    ORDER ||--|{ LINE_ITEM : contains',
  gantt: 'gantt\n    title Project plan\n    dateFormat YYYY-MM-DD\n    section Phase 1\n    Task 1 :a1, 2024-01-01, 5d',
  pie: 'pie title Distribution\n    "Category A" : 40\n    "Category B" : 30\n    "Category C" : 30',
  timeline: 'timeline\n    title Timeline\n    2024 : Event one\n    2025 : Event two',
  mindmap: 'mindmap\n    root((Central idea))\n        Branch 1\n        Branch 2',
  other: 'flowchart TD\n    A[Start] --> B[Next step]',
}

export function starterFor(kind: DiagramKind): string {
  return MERMAID_STARTERS[kind]
}

export const DIAGRAM_KINDS: DiagramKind[] = [
  'flowchart', 'mindmap', 'sequence', 'class', 'state', 'er', 'gantt', 'pie', 'timeline',
]

// Kind is never stored — always derived from the source's first non-comment line. This
// avoids drift between a stored `kind` prop and the diagram's actual type (an edit could
// change the real type while a stale prop still pointed at the old one).
export function detectMermaidKind(source: string): DiagramKind {
  const line = source
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('%%')) ?? ''
  const head = line.split(/\s+/)[0]?.toLowerCase() ?? ''
  if (head === 'flowchart' || head === 'graph') return 'flowchart'
  if (head === 'sequencediagram') return 'sequence'
  if (head.startsWith('classdiagram')) return 'class'
  if (head.startsWith('statediagram')) return 'state'
  if (head === 'erdiagram') return 'er'
  if (head === 'gantt') return 'gantt'
  if (head === 'pie') return 'pie'
  if (head === 'timeline') return 'timeline'
  if (head === 'mindmap') return 'mindmap'
  return 'other'
}

function uid(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
  }
}

export function newDiagramId(): string {
  return `d-${uid()}`
}

// ─── Sanitize-before-render ──────────────────────────────────────────────────

export interface RenderResult {
  svg: string
  error: string | null
}

type MermaidModule = typeof import('mermaid')['default']
type DOMPurifyModule = typeof import('dompurify')['default']

let depsPromise: Promise<{ mermaid: MermaidModule; DOMPurify: DOMPurifyModule }> | null = null

// Mermaid + DOMPurify are dynamically imported together (memoized) rather than statically
// bundled, consistent with this codebase's existing pattern of lazy-loading heavy/optional
// export libraries (jspdf, html2canvas, docx, turndown in utils/export.ts).
function loadDeps() {
  if (!depsPromise) {
    depsPromise = Promise.all([import('mermaid'), import('dompurify')]).then(([m, p]) => {
      m.default.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' })
      return { mermaid: m.default, DOMPurify: p.default }
    })
  }
  return depsPromise
}

// Mermaid renders the root <svg> as a responsive element — `width="100%"` plus an inline
// `style="max-width:<natural>px"` — so it shrinks to fit its container rather than
// overflowing. That defeats the point of the overflow-x:auto wrapper: a wide Gantt/ER
// diagram would just shrink to illegibility instead of staying legible and scrolling. Force
// the SVG back to its natural pixel width (from the viewBox) so wide diagrams genuinely
// overflow their container and the wrapper's horizontal scroll does real work; diagrams
// narrower than the container are unaffected either way.
function applyNaturalSize(svg: string): string {
  const rootMatch = svg.match(/<svg\b[^>]*>/)
  if (!rootMatch) return svg
  const rootTag = rootMatch[0]
  const vb = rootTag.match(/viewBox="[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)"/)
  if (!vb) return svg
  const width = vb[1]
  const stripped = rootTag.replace(/\swidth="[^"]*"/, '').replace(/\sstyle="[^"]*"/, '')
  const withWidth = stripped.replace(/^<svg/, `<svg width="${width}"`)
  return svg.replace(rootTag, withWidth)
}

// Render Mermaid source to a sanitized SVG string. Never throws — invalid syntax or a
// render failure comes back as { svg: '', error: '<message>' } so every call site can show
// an inline error state instead of crashing the note.
//
// Render calls are serialized through a promise queue as a defensive measure against any
// concurrency issues in Mermaid's internal render sandbox when multiple diagrams render at
// once (e.g. a note with several diagram blocks, or rapid edits while typing).
let queue: Promise<unknown> = Promise.resolve()
let seq = 0

export function renderMermaid(source: string): Promise<RenderResult> {
  const run = async (): Promise<RenderResult> => {
    const text = source.trim()
    if (!text) return { svg: '', error: null }
    const { mermaid, DOMPurify } = await loadDeps()
    let parseOk = false
    try {
      parseOk = (await mermaid.parse(text, { suppressErrors: true })) !== false
    } catch {
      parseOk = false
    }
    if (!parseOk) return { svg: '', error: 'This diagram has invalid Mermaid syntax.' }
    try {
      const { svg } = await mermaid.render(`gecko-mmd-${++seq}-${Date.now().toString(36)}`, text)
      const clean = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        ADD_TAGS: ['style', 'foreignObject'],
        ADD_ATTR: ['target'],
      })
      return { svg: applyNaturalSize(clean), error: null }
    } catch (e) {
      return { svg: '', error: e instanceof Error ? e.message : 'Failed to render this diagram.' }
    }
  }
  const result = queue.then(run, run)
  queue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

// Lighter-weight validation-only check (no render, no sanitize) for the AI executor, which
// only needs to know whether the model's Mermaid source is well-formed before persisting it.
export async function validateMermaidSource(source: string): Promise<{ ok: boolean; error?: string }> {
  const text = source.trim()
  if (!text) return { ok: false, error: 'Diagram source is empty' }
  const { mermaid } = await loadDeps()
  try {
    const ok = (await mermaid.parse(text, { suppressErrors: true })) !== false
    return ok ? { ok: true } : { ok: false, error: 'Invalid Mermaid syntax' }
  } catch {
    return { ok: false, error: 'Invalid Mermaid syntax' }
  }
}

// Base64 data URI for a rendered SVG string — used by exporters that embed images (HTML,
// Markdown). Unicode-safe (btoa alone throws on multi-byte characters).
export function svgToDataUri(svg: string): string {
  const bytes = new TextEncoder().encode(svg)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return `data:image/svg+xml;base64,${btoa(bin)}`
}

// ─── Note-link convention ────────────────────────────────────────────────────
// The app's own link-insertion UI always writes a literal relative href — never a custom
// scheme — so both the frontend (finding anchors to intercept) and the backend
// (extract_linked_note_ids, a plain regex over the source) can extract linked note ids
// without a Mermaid grammar parse:
//   click <nodeId> href "/notes/<noteId>"
//   click <nodeId> href "<url>" "_blank"

const NOTE_LINK_HREF_RE = /^\/notes\/([^/?#]+)/

export function noteIdFromHref(href: string): string | null {
  const m = NOTE_LINK_HREF_RE.exec(href)
  return m ? m[1] : null
}

export function buildNoteLinkDirective(nodeId: string, noteId: string): string {
  return `click ${nodeId} href "/notes/${noteId}"`
}

export function buildUrlLinkDirective(nodeId: string, url: string): string {
  return `click ${nodeId} href "${url}" "_blank"`
}

// ─── AI context ──────────────────────────────────────────────────────────────

// A compact, human-readable listing of the diagrams embedded in a note's blocks, so the AI
// assistant can see them (invisible in the Markdown body it's given) and target one with
// edit_diagram. Returns '' when the note has no diagrams.
export function describeDiagrams(blocks: unknown[]): string {
  const out: string[] = []
  const walk = (list: unknown[]) => {
    for (const b of list) {
      const rec = b as Record<string, unknown> | null
      if (!rec || typeof rec !== 'object') continue
      if (rec.type === 'diagram') {
        const props = (rec.props as Record<string, unknown>) || {}
        const id = String(props.diagramId ?? '')
        const source = String(props.source ?? '')
        const kind = detectMermaidKind(source)
        const truncated = source.length > 800 ? `${source.slice(0, 800)}…` : source
        out.push(`[diagram ${id}] kind=${kind}\n${truncated}`)
      }
      if (Array.isArray(rec.children)) walk(rec.children as unknown[])
    }
  }
  walk(blocks)
  return out.join('\n\n')
}

// ─── Auto-open registry ──────────────────────────────────────────────────────
// A freshly slash-inserted diagram should open its editor immediately. The block can't be
// told to open via props (props persist in the note), so the insert helper records the new
// diagram's id here and the block consumes it once on mount.

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
