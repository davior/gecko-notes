import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MessageSquareText, Trash2, CornerDownRight, X } from 'lucide-react'
import type { Annotation } from '@/api/annotations'

interface AnnotationLayerProps {
  // The `position: relative` wrapper that also contains the BlockNoteView. Block
  // elements are located inside it via their `data-id` attribute (== block.id).
  containerRef: React.RefObject<HTMLDivElement | null>
  annotations: Annotation[]
  openId: string | null
  onOpen: (id: string | null) => void
  onSave: (id: string, text: string) => void
  onDelete: (id: string) => void
  onInsert: (annotation: Annotation) => void
}

interface IconPos { id: string; top: number; left: number }

function findBlockEl(container: HTMLElement, blockId: string): HTMLElement | null {
  // BlockNote tags each block's DOM node with data-id === block.id.
  return container.querySelector<HTMLElement>(`[data-id="${CSS.escape(blockId)}"]`)
}

export default function AnnotationLayer({
  containerRef, annotations, openId, onOpen, onSave, onDelete, onInsert,
}: AnnotationLayerProps) {
  const [positions, setPositions] = useState<IconPos[]>([])
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null)
  const iconRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const highlightedEl = useRef<HTMLElement | null>(null)

  // Recompute icon positions from live block DOM rects (relative to the wrapper,
  // so they stay correct as the parent scrolls — both rects shift together).
  const measure = useCallback(() => {
    const container = containerRef.current
    if (!container) { setPositions([]); return }
    const wrapRect = container.getBoundingClientRect()
    const next: IconPos[] = []
    for (const a of annotations) {
      const el = findBlockEl(container, a.block_id)
      if (!el) continue // orphaned anchor (e.g. block removed) — simply not shown
      const r = el.getBoundingClientRect()
      next.push({
        id: a.id,
        top: r.top - wrapRect.top + r.height / 2 - 12,
        left: r.right - wrapRect.left - 8,
      })
    }
    setPositions(next)
  }, [annotations, containerRef])

  // Re-measure on any content/size change. A MutationObserver catches block
  // add/remove and text edits; a ResizeObserver catches height changes (images,
  // window resize). Both coalesce through requestAnimationFrame.
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    let raf = 0
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure) }
    schedule()
    const mo = new MutationObserver(schedule)
    mo.observe(container, { childList: true, subtree: true, characterData: true, attributes: true })
    const ro = new ResizeObserver(schedule)
    ro.observe(container)
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(raf)
      mo.disconnect()
      ro.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [measure, containerRef])

  // Highlight the anchored block while its icon is hovered or its panel is open.
  useEffect(() => {
    const container = containerRef.current
    const activeId = openId ?? hoverId
    const annotation = annotations.find((a) => a.id === activeId)
    if (highlightedEl.current) {
      highlightedEl.current.classList.remove('annotation-highlight')
      highlightedEl.current = null
    }
    if (container && annotation) {
      const el = findBlockEl(container, annotation.block_id)
      if (el) { el.classList.add('annotation-highlight'); highlightedEl.current = el }
    }
    return () => {
      if (highlightedEl.current) {
        highlightedEl.current.classList.remove('annotation-highlight')
        highlightedEl.current = null
      }
    }
  }, [hoverId, openId, annotations, containerRef, positions])

  // Position the floating panel next to the open annotation's icon.
  useEffect(() => {
    if (!openId) { setPanelPos(null); return }
    const btn = iconRefs.current.get(openId)
    if (!btn) return
    const r = btn.getBoundingClientRect()
    const width = 320
    const left = Math.min(r.right + 8, window.innerWidth - width - 8)
    setPanelPos({ top: Math.min(r.top, window.innerHeight - 240), left: Math.max(8, left) })
  }, [openId, positions])

  // Position the hover tooltip. The icon sits at the block's right edge, so
  // prefer the left side (falling back to the right) and render it through a
  // portal so it is never clipped by the editor's scroll container or the AI panel.
  const TOOLTIP_WIDTH = 256
  useEffect(() => {
    if (!hoverId || hoverId === openId) { setTooltipPos(null); return }
    const btn = iconRefs.current.get(hoverId)
    if (!btn) { setTooltipPos(null); return }
    const r = btn.getBoundingClientRect()
    let left = r.left - TOOLTIP_WIDTH - 8
    if (left < 8) left = Math.min(r.right + 8, window.innerWidth - TOOLTIP_WIDTH - 8)
    setTooltipPos({ top: r.top, left: Math.max(8, left) })
  }, [hoverId, openId, positions])

  const hoverAnnotation = hoverId && hoverId !== openId ? annotations.find((a) => a.id === hoverId) ?? null : null

  const openAnnotation = annotations.find((a) => a.id === openId) ?? null

  return (
    <>
      <div className="pointer-events-none absolute inset-0 z-10">
        {positions.map((p) => {
          const annotation = annotations.find((a) => a.id === p.id)
          if (!annotation) return null
          const isOpen = openId === p.id
          return (
            <div key={p.id} className="absolute" style={{ top: p.top, left: p.left }}>
              <button
                ref={(el) => { if (el) iconRefs.current.set(p.id, el); else iconRefs.current.delete(p.id) }}
                type="button"
                contentEditable={false}
                className={`pointer-events-auto flex items-center justify-center w-6 h-6 rounded-full border shadow-sm transition-colors ${
                  isOpen
                    ? 'bg-amber-500 border-amber-500 text-white'
                    : 'bg-amber-50 border-amber-300 text-amber-600 hover:bg-amber-100 dark:bg-amber-900/40 dark:border-amber-700 dark:text-amber-300'
                }`}
                title="Annotation"
                onMouseEnter={() => setHoverId(p.id)}
                onMouseLeave={() => setHoverId((h) => (h === p.id ? null : h))}
                onClick={() => onOpen(isOpen ? null : p.id)}
              >
                <MessageSquareText className="w-3.5 h-3.5" />
              </button>
            </div>
          )
        })}
      </div>

      {hoverAnnotation && tooltipPos && createPortal(
        <div
          className="pointer-events-none fixed z-[55] w-64 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg px-3 py-2 text-xs text-gray-700 dark:text-gray-200"
          style={{ top: tooltipPos.top, left: tooltipPos.left }}
        >
          {hoverAnnotation.text.trim() ? (
            <div className="annotation-tooltip-body max-h-40 overflow-hidden">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{hoverAnnotation.text}</ReactMarkdown>
            </div>
          ) : (
            <span className="italic text-gray-400">Empty annotation — click to edit</span>
          )}
        </div>,
        document.body,
      )}

      {openAnnotation && panelPos && (
        <AnnotationPanel
          annotation={openAnnotation}
          pos={panelPos}
          onClose={() => onOpen(null)}
          onSave={onSave}
          onDelete={onDelete}
          onInsert={onInsert}
        />
      )}
    </>
  )
}

interface PanelProps {
  annotation: Annotation
  pos: { top: number; left: number }
  onClose: () => void
  onSave: (id: string, text: string) => void
  onDelete: (id: string) => void
  onInsert: (annotation: Annotation) => void
}

function AnnotationPanel({ annotation, pos, onClose, onSave, onDelete, onInsert }: PanelProps) {
  const [text, setText] = useState(annotation.text)
  const panelRef = useRef<HTMLDivElement>(null)
  const textRef = useRef(text)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  textRef.current = text

  // Reset the draft when switching to a different annotation.
  useEffect(() => { setText(annotation.text) }, [annotation.id])

  const flush = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    if (textRef.current !== annotation.text) onSave(annotation.id, textRef.current)
  }, [annotation.id, annotation.text, onSave])

  // Debounced autosave, plus a flush on unmount so a quick close still persists.
  const handleChange = (value: string) => {
    setText(value)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => onSave(annotation.id, value), 600)
  }
  useEffect(() => flush, [flush])

  // Close on outside click / Escape.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!panelRef.current?.contains(e.target as Node)) { flush(); onClose() }
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { flush(); onClose() } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [flush, onClose])

  return createPortal(
    <div
      ref={panelRef}
      className="fixed z-[60] w-80 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-xl flex flex-col"
      style={{ top: pos.top, left: pos.left }}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-gray-700">
        <span className="text-xs font-medium text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
          <MessageSquareText className="w-3.5 h-3.5" /> Annotation
        </span>
        <button className="btn-ghost p-1" title="Close" onClick={() => { flush(); onClose() }}>
          <X className="w-4 h-4" />
        </button>
      </div>
      <textarea
        autoFocus
        className="w-full resize-y px-3 py-2 text-sm bg-transparent text-gray-800 dark:text-gray-100 focus:outline-none min-h-[120px]"
        placeholder="Write an annotation… (markdown supported)"
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={flush}
      />
      <div className="flex items-center gap-2 px-3 py-2 border-t border-gray-100 dark:border-gray-700">
        <button
          className="btn-secondary text-xs flex items-center gap-1.5 px-2 py-1"
          title="Insert this annotation into the note and remove it"
          onClick={() => { flush(); onInsert({ ...annotation, text: textRef.current }) }}
        >
          <CornerDownRight className="w-3.5 h-3.5" /> Insert into note
        </button>
        <div className="flex-1" />
        <button
          className="btn-ghost text-xs text-red-500 hover:text-red-600 flex items-center gap-1.5 px-2 py-1"
          title="Delete annotation"
          onClick={() => onDelete(annotation.id)}
        >
          <Trash2 className="w-3.5 h-3.5" /> Delete
        </button>
      </div>
    </div>,
    document.body,
  )
}
