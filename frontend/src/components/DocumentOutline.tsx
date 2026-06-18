import { useCallback, useEffect, useState } from 'react'
import { useEditorChange } from '@blocknote/react'
import type { BlockNoteEditor } from '@blocknote/core'
import { List, PanelLeftClose } from 'lucide-react'
import { extractHeadings, type OutlineHeading } from '@/utils/blocks'

interface DocumentOutlineProps {
  /** The editor whose document supplies the heading hierarchy. */
  editor: BlockNoteEditor<any, any, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  /**
   * The scrollable element that contains the rendered blocks. Used both to locate
   * heading elements (by `data-id`) and as the scroll target — we scroll this
   * element directly rather than `scrollIntoView`, which would scroll every
   * scrollable ancestor (and the page).
   */
  scrollContainerRef: React.RefObject<HTMLElement | null>
  /** localStorage key for the open/collapsed state (editor & shared views differ). */
  storageKey?: string
  /** Gap (px) left above a heading after scrolling — e.g. to clear a sticky header. */
  scrollOffset?: number
}

function findBlockEl(container: HTMLElement, id: string): HTMLElement | null {
  // BlockNote tags each block's DOM node with data-id === block.id.
  return container.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)
}

export default function DocumentOutline({
  editor,
  scrollContainerRef,
  storageKey = 'outline-panel-open',
  scrollOffset = 16,
}: DocumentOutlineProps) {
  const [headings, setHeadings] = useState<OutlineHeading[]>(() => extractHeadings(editor.document))
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(storageKey) !== 'false' } catch { return true }
  })
  const [activeId, setActiveId] = useState<string | null>(null)

  // Recompute on any document change (typing, hydration, AI edits, restore, …).
  useEditorChange(() => setHeadings(extractHeadings(editor.document)), editor)

  useEffect(() => {
    try { localStorage.setItem(storageKey, String(open)) } catch { /* noop */ }
  }, [open, storageKey])

  // Scroll-spy: mark the heading nearest the top of the scroll viewport as active.
  // Throttled through requestAnimationFrame; re-runs whenever the heading set changes.
  useEffect(() => {
    const scroller = scrollContainerRef.current
    if (!scroller || headings.length === 0) { setActiveId(null); return }
    let raf = 0
    const update = () => {
      raf = 0
      const line = scroller.getBoundingClientRect().top + scrollOffset + 1
      let current: string | null = null
      for (const h of headings) {
        const el = findBlockEl(scroller, h.id)
        if (el && el.getBoundingClientRect().top <= line) current = h.id
      }
      setActiveId(current ?? headings[0].id)
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update) }
    update()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      scroller.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [headings, scrollContainerRef, scrollOffset])

  const goToHeading = useCallback((id: string) => {
    const scroller = scrollContainerRef.current
    if (!scroller) return
    const el = findBlockEl(scroller, id)
    if (!el) return
    const top = scroller.scrollTop + (el.getBoundingClientRect().top - scroller.getBoundingClientRect().top) - scrollOffset
    scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    setActiveId(id)
    // Briefly flash the heading so it's obvious where the jump landed.
    el.classList.add('outline-target-flash')
    window.setTimeout(() => el.classList.remove('outline-target-flash'), 1200)
  }, [scrollContainerRef, scrollOffset])

  // Indent relative to the shallowest heading present, so a note that starts at
  // H2 isn't pushed in for no reason.
  const minLevel = headings.reduce((m, h) => Math.min(m, h.level), 6)

  if (!open) {
    return (
      <div className="shrink-0 flex sm:flex-col items-center justify-center no-print">
        <button
          onClick={() => setOpen(true)}
          className="sm:h-full w-full sm:w-9 flex sm:flex-col items-center justify-center gap-2 px-3 sm:px-0 py-2 sm:py-0 border-b sm:border-b-0 sm:border-r border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 hover:bg-blue-50 dark:hover:bg-blue-900/20 hover:text-blue-500 text-gray-400 transition-colors"
          title="Show document outline"
        >
          <List className="w-4 h-4" />
          <span className="text-xs sm:hidden">Outline</span>
          <span className="hidden sm:block text-xs font-medium tracking-widest" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
            Outline
          </span>
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col shrink-0 w-full sm:w-60 border-b sm:border-b-0 sm:border-r border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-900 no-print">
      <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-gray-700">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-gray-800 dark:text-gray-100">
          <List className="w-4 h-4 text-blue-500" />
          Outline
        </div>
        <button onClick={() => setOpen(false)} className="btn-ghost p-1" title="Hide outline">
          <PanelLeftClose className="w-4 h-4" />
        </button>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto py-2 max-h-60 sm:max-h-none">
        {headings.length === 0 ? (
          <p className="px-4 py-3 text-xs text-gray-400 dark:text-gray-500">
            No headings yet. Add headings to build an outline.
          </p>
        ) : (
          <ul className="text-sm">
            {headings.map((h) => (
              <li key={h.id}>
                <button
                  onClick={() => goToHeading(h.id)}
                  title={h.text || 'Untitled heading'}
                  style={{ paddingLeft: `${0.75 + (h.level - minLevel) * 0.85}rem` }}
                  className={`block w-full text-left truncate pr-3 py-1 border-l-2 transition-colors ${
                    activeId === h.id
                      ? 'border-blue-500 text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 font-medium'
                      : 'border-transparent text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
                  }`}
                >
                  {h.text || <span className="italic text-gray-400">Untitled heading</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
    </div>
  )
}
