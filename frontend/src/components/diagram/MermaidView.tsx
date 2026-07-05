import { useEffect, useRef, useState } from 'react'
import { renderMermaid, noteIdFromHref } from '@/utils/diagram'

export interface NoteLinkResolution {
  disabled: boolean
  title?: string
  onClick?: () => void
}

interface Props {
  source: string
  // Interactive: note-link anchors become clickable (or show a disabled state) via
  // resolveNoteLink; external-url anchors behave normally. Non-interactive: the whole
  // rendered SVG gets pointer-events:none so a click falls through to the host (e.g. the
  // block's own "open editor" button) instead of following a link.
  interactive: boolean
  resolveNoteLink?: (noteId: string) => NoteLinkResolution
  className?: string
  minHeight?: number | string
}

// Renders Mermaid source to sanitized SVG (via renderMermaid, the single sanitize/parse
// choke point — see utils/diagram.ts) and shows a loading skeleton, an inline "invalid
// syntax" state, or the diagram. Used identically by the block's inline preview, the
// block's read-only shared/history render, and the editor modal's live preview — Mermaid
// diagrams are never draggable regardless of context, so there is only one render path
// (unlike the old React Flow implementation's editable/read-only canvas split).
export default function MermaidView({ source, interactive, resolveNoteLink, className, minHeight = 80 }: Props) {
  const [result, setResult] = useState<{ svg: string; error: string | null } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(() => {
      void renderMermaid(source).then((r) => {
        if (!cancelled) setResult(r)
      })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [source])

  // Wire up anchors after the sanitized SVG is in the DOM. Mermaid renders SVG anchors
  // with the SVG1.1-style `xlink:href` attribute rather than a plain `href`, so both are
  // checked. Note: mermaid.render()'s static SVG output does NOT encode the `"_blank"`
  // target hint from `click <id> href "url" "_blank"` as an HTML `target` attribute (that
  // only happens through Mermaid's bindFunctions()/run() DOM-integration path, which this
  // app doesn't use) — so external-url anchors get target/rel set explicitly here.
  useEffect(() => {
    const container = containerRef.current
    if (!container || !interactive) return
    const anchors = Array.from(container.querySelectorAll('a')) as unknown as SVGAElement[]
    const cleanups: Array<() => void> = []
    for (const a of anchors) {
      const href = a.getAttribute('href') ?? a.getAttribute('xlink:href') ?? ''
      const noteId = noteIdFromHref(href)
      if (!noteId) {
        if (href) {
          a.setAttribute('target', '_blank')
          a.setAttribute('rel', 'noopener noreferrer')
        }
        continue
      }
      if (!resolveNoteLink) continue
      const resolved = resolveNoteLink(noteId)
      if (resolved.disabled) {
        // pointer-events:none only blocks real mouse hit-testing — it does not stop
        // keyboard activation (Tab + Enter/Space) or a scripted click from following the
        // native href, so the href/xlink:href are also stripped to fully neutralize
        // navigation. "Never fall back to the private URL from the shared view" is a hard
        // requirement, not just a visual affordance.
        a.removeAttribute('href')
        a.removeAttribute('xlink:href')
        a.setAttribute('aria-disabled', 'true')
        a.setAttribute('tabindex', '-1')
        a.style.opacity = '0.45'
        a.style.cursor = 'not-allowed'
        a.style.pointerEvents = 'none'
        if (resolved.title) a.setAttribute('title', resolved.title)
        continue
      }
      const handler = (e: MouseEvent) => {
        e.preventDefault()
        resolved.onClick?.()
      }
      a.addEventListener('click', handler)
      a.style.cursor = 'pointer'
      cleanups.push(() => a.removeEventListener('click', handler))
    }
    return () => cleanups.forEach((fn) => fn())
  }, [result, interactive, resolveNoteLink])

  return (
    <div
      ref={containerRef}
      className={`mermaid-view overflow-x-auto ${className ?? ''}`}
      style={{ minHeight, pointerEvents: interactive ? 'auto' : 'none' }}
    >
      {result === null ? (
        <div className="flex items-center justify-center text-xs text-gray-400 py-6">Rendering…</div>
      ) : result.error ? (
        <div className="text-xs text-red-500 px-3 py-4">{result.error}</div>
      ) : result.svg ? (
        <div
          // First-party output, sanitized by DOMPurify inside renderMermaid() before it
          // ever reaches this component — see the security note there.
          dangerouslySetInnerHTML={{ __html: result.svg }}
        />
      ) : (
        <div className="text-xs text-gray-400 px-3 py-4">Empty diagram.</div>
      )}
    </div>
  )
}
