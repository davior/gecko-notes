import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditorChange } from '@blocknote/react'
import type { BlockNoteEditor } from '@blocknote/core'
import { Search, Replace, ReplaceAll, ChevronUp, ChevronDown, ChevronRight, X } from 'lucide-react'
import {
  computeMatches, replaceAll, replaceCurrent,
  type FindMatch, type FindMode, type FindOptions,
} from '@/utils/findReplace'

interface FindReplaceBarProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches DocumentOutline's loose editor typing
  editor: BlockNoteEditor<any, any, any>
  /** The scrollable editor container — scroll target and where blocks are located by `data-id`. */
  scrollContainerRef: React.RefObject<HTMLElement | null>
  open: boolean
  /** Open with the replace row already expanded (Ctrl/Cmd+H vs Ctrl/Cmd+F). */
  showReplace: boolean
  onClose: () => void
}

/** Gap left above a match after scrolling, so it clears the floating bar. */
const SCROLL_OFFSET = 64

/**
 * In-note Find & Replace bar. Floats over the top-right of the editor area. Matches
 * are computed over `editor.document` (see utils/findReplace) for both plain-text
 * and regex modes and kept live via `useEditorChange`; navigation scrolls to and
 * flashes the matching block (the same `data-id` + `outline-target-flash` pattern
 * DocumentOutline uses). Replacements go through the editor API, so the existing
 * autosave and undo history pick them up with no extra wiring.
 */
export default function FindReplaceBar({ editor, scrollContainerRef, open, showReplace, onClose }: FindReplaceBarProps) {
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [mode, setMode] = useState<FindMode>('text')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [replaceVisible, setReplaceVisible] = useState(showReplace)
  const [matches, setMatches] = useState<FindMatch[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [regexError, setRegexError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')

  const findInputRef = useRef<HTMLInputElement>(null)

  // Latest options, read by the useEditorChange callback (which would otherwise
  // close over stale state).
  const opts: FindOptions = { query, mode, caseSensitive, wholeWord }
  const optsRef = useRef(opts)
  optsRef.current = opts
  const openRef = useRef(open)
  openRef.current = open

  const scrollToBlock = useCallback((blockId: string) => {
    const scroller = scrollContainerRef.current
    if (!scroller) return
    const el = scroller.querySelector<HTMLElement>(`[data-id="${CSS.escape(blockId)}"]`)
    if (!el) return
    const top = scroller.scrollTop + (el.getBoundingClientRect().top - scroller.getBoundingClientRect().top) - SCROLL_OFFSET
    scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    el.classList.add('outline-target-flash')
    window.setTimeout(() => el.classList.remove('outline-target-flash'), 1200)
  }, [scrollContainerRef])

  // Recompute when the query or any option changes (debounced), reset to the first
  // match and scroll to it — the "type to search" behaviour.
  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => {
      const { matches: ms, error } = computeMatches(editor.document, { query, mode, caseSensitive, wholeWord })
      setRegexError(error)
      setMatches(ms)
      setCurrentIndex(0)
      if (ms.length) scrollToBlock(ms[0].blockId)
    }, 150)
    return () => window.clearTimeout(t)
  }, [query, mode, caseSensitive, wholeWord, open, editor, scrollToBlock])

  // Keep matches in sync with edits to the document (typing, AI edits, our own
  // replacements). Clamp the current index without moving the viewport.
  useEditorChange(() => {
    if (!openRef.current) return
    const { matches: ms, error } = computeMatches(editor.document, optsRef.current)
    setRegexError(error)
    setMatches(ms)
    setCurrentIndex((prev) => (ms.length === 0 ? 0 : Math.min(prev, ms.length - 1)))
  }, editor)

  // Focus & select the find field when the bar opens; sync the replace row.
  useEffect(() => {
    if (!open) return
    setReplaceVisible(showReplace)
    const el = findInputRef.current
    if (el) { el.focus(); el.select() }
    // Only when `open` flips — reopening should re-focus. showReplace handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => { if (open && showReplace) setReplaceVisible(true) }, [open, showReplace])

  // Escape closes the bar from anywhere while it's open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Auto-clear the transient "Replaced N" notice.
  useEffect(() => {
    if (!notice) return
    const t = window.setTimeout(() => setNotice(''), 2500)
    return () => window.clearTimeout(t)
  }, [notice])

  if (!open) return null

  const go = (index: number) => {
    if (!matches.length) return
    const wrapped = ((index % matches.length) + matches.length) % matches.length
    setCurrentIndex(wrapped)
    scrollToBlock(matches[wrapped].blockId)
  }
  const next = () => go(currentIndex + 1)
  const prev = () => go(currentIndex - 1)

  const doReplaceCurrent = () => {
    if (!matches.length || regexError) return
    const idx = currentIndex
    replaceCurrent(editor, { query, mode, caseSensitive, wholeWord }, replacement, matches, idx)
    // The edit is applied synchronously; recompute and advance to the next match.
    const { matches: ms } = computeMatches(editor.document, { query, mode, caseSensitive, wholeWord })
    setMatches(ms)
    const ni = ms.length === 0 ? 0 : Math.min(idx, ms.length - 1)
    setCurrentIndex(ni)
    if (ms.length) scrollToBlock(ms[ni].blockId)
  }

  const doReplaceAll = () => {
    if (!matches.length || regexError) return
    const count = replaceAll(editor, { query, mode, caseSensitive, wholeWord }, replacement)
    const { matches: ms } = computeMatches(editor.document, { query, mode, caseSensitive, wholeWord })
    setMatches(ms)
    setCurrentIndex(0)
    setNotice(`Replaced ${count}`)
  }

  const hasMatches = matches.length > 0
  const counter = notice
    ? notice
    : regexError
      ? ''
      : hasMatches
        ? `${currentIndex + 1} of ${matches.length}`
        : query
          ? 'No results'
          : ''

  return (
    <div className="absolute top-2 right-4 z-30 w-[22rem] max-w-[calc(100%-1.5rem)] card shadow-lg hover:shadow-lg hover:translate-y-0 p-2 no-print">
      {/* Find row */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="btn-ghost p-1.5 shrink-0"
          title={replaceVisible ? 'Hide replace' : 'Show replace'}
          onClick={() => setReplaceVisible((v) => !v)}
        >
          {replaceVisible ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
          <input
            ref={findInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? prev() : next() } }}
            type="text"
            placeholder="Find"
            aria-label="Find"
            className="input pl-8 pr-7 py-1.5 text-sm"
          />
          {query && (
            <button
              type="button"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              title="Clear"
              onClick={() => { setQuery(''); findInputRef.current?.focus() }}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <span className="text-[11px] text-gray-400 dark:text-gray-500 tabular-nums whitespace-nowrap text-right shrink-0 w-[4.5rem]">
          {counter}
        </span>
        <button type="button" className="btn-ghost p-1.5 shrink-0" title="Previous (Shift+Enter)" disabled={!hasMatches} onClick={prev}>
          <ChevronUp className="w-4 h-4" />
        </button>
        <button type="button" className="btn-ghost p-1.5 shrink-0" title="Next (Enter)" disabled={!hasMatches} onClick={next}>
          <ChevronDown className="w-4 h-4" />
        </button>
        <button type="button" className="btn-ghost p-1.5 shrink-0" title="Close (Esc)" onClick={onClose}>
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Replace row */}
      {replaceVisible && (
        <div className="flex items-center gap-1 mt-1.5">
          <span className="w-7 shrink-0" aria-hidden />
          <div className="relative flex-1 min-w-0">
            <Replace className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            <input
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doReplaceCurrent() } }}
              type="text"
              placeholder={mode === 'regex' ? 'Replace ($1, $&…)' : 'Replace'}
              aria-label="Replace"
              className="input pl-8 pr-2 py-1.5 text-sm"
            />
          </div>
          <button type="button" className="btn-ghost p-1.5 shrink-0" title="Replace" disabled={!hasMatches || !!regexError} onClick={doReplaceCurrent}>
            <Replace className="w-4 h-4" />
          </button>
          <button type="button" className="btn-ghost p-1.5 shrink-0" title="Replace all" disabled={!hasMatches || !!regexError} onClick={doReplaceAll}>
            <ReplaceAll className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Options row */}
      <div className="flex items-center gap-1 mt-1.5 pl-8">
        <div className="flex items-center gap-0.5 p-0.5 bg-gray-100 dark:bg-gray-700 rounded-lg">
          <ToggleButton active={caseSensitive} onClick={() => setCaseSensitive((v) => !v)} label="Aa" title="Match case" />
          <ToggleButton active={wholeWord} onClick={() => setWholeWord((v) => !v)} disabled={mode === 'regex'} label="\b" title="Whole word (text mode)" />
          <ToggleButton active={mode === 'regex'} onClick={() => setMode((m) => (m === 'regex' ? 'text' : 'regex'))} label=".*" title="Use regular expression" />
        </div>
        {regexError && (
          <span className="text-xs text-red-500 truncate" title={regexError}>{regexError}</span>
        )}
      </div>
    </div>
  )
}

function ToggleButton({ active, onClick, label, title, disabled }: {
  active: boolean
  onClick: () => void
  label: string
  title: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`px-2 py-0.5 rounded-md text-xs font-mono transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        active
          ? 'bg-white dark:bg-gray-800 shadow-sm text-blue-600 dark:text-blue-400'
          : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
      }`}
    >
      {label}
    </button>
  )
}
