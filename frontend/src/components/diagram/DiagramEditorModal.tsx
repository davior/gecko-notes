import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, Minimize2, X, Check, Link2, FileText } from 'lucide-react'
import NotePickerModal from '@/components/NotePickerModal'
import MermaidView from './MermaidView'
import {
  DIAGRAM_KINDS,
  DIAGRAM_KIND_LABELS,
  KIND_SUPPORTS_LINKS,
  detectMermaidKind,
  starterFor,
  buildNoteLinkDirective,
  buildUrlLinkDirective,
  type DiagramKind,
} from '@/utils/diagram'

interface Props {
  initialSource: string
  onSave: (source: string) => void
  onClose: () => void
}

export default function DiagramEditorModal({ initialSource, onSave, onClose }: Props) {
  const [source, setSource] = useState(initialSource)
  const [fullscreen, setFullscreen] = useState(false)
  const [showNotePicker, setShowNotePicker] = useState(false)
  const [nodeId, setNodeId] = useState('')
  const [urlInput, setUrlInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const kind = useMemo(() => detectMermaidKind(source), [source])
  const linksSupported = KIND_SUPPORTS_LINKS[kind]

  // Persist edits back to the block (which triggers the note's autosave) shortly after
  // each change, and flush immediately on close. Skip the initial mount so merely opening
  // the editor doesn't mark the note dirty.
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    const t = setTimeout(() => onSaveRef.current(source), 400)
    return () => clearTimeout(t)
  }, [source])

  function changeKind(next: DiagramKind) {
    if (next === kind) return
    const trivial = !source.trim() || source.trim() === starterFor(kind).trim()
    if (!trivial && !window.confirm('Switching diagram type replaces the current content with a new starter template. Continue?')) {
      return
    }
    setSource(starterFor(next))
  }

  function appendDirective(line: string) {
    setSource((s) => (s.trimEnd() ? `${s.trimEnd()}\n${line}\n` : `${line}\n`))
  }

  function handleLinkToNote(noteId_: string, noteTitle: string) {
    if (!nodeId.trim()) return
    appendDirective(buildNoteLinkDirective(nodeId.trim(), noteId_))
    setShowNotePicker(false)
    void noteTitle
  }

  function handleLinkToUrl() {
    if (!nodeId.trim() || !urlInput.trim()) return
    appendDirective(buildUrlLinkDirective(nodeId.trim(), urlInput.trim()))
    setUrlInput('')
  }

  function handleClose() {
    onSaveRef.current(source)
    onClose()
  }

  const panelStyle: React.CSSProperties = fullscreen
    ? { position: 'fixed', inset: 12, width: 'auto', height: 'auto', maxWidth: 'none' }
    : { width: 'min(1100px, 94vw)', height: 'min(760px, 88vh)' }

  return createPortal(
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center" onClick={handleClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl overflow-hidden flex flex-col"
        style={panelStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 dark:border-gray-700 flex-wrap">
          <select
            value={kind}
            onChange={(e) => changeKind(e.target.value as DiagramKind)}
            className="text-xs font-medium px-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 outline-none"
          >
            {DIAGRAM_KINDS.map((k) => (
              <option key={k} value={k}>{DIAGRAM_KIND_LABELS[k]}</option>
            ))}
          </select>

          <div className="ml-auto flex items-center gap-1">
            <button
              className="btn-ghost p-1.5"
              title={fullscreen ? 'Exit full screen' : 'Full screen'}
              onClick={() => setFullscreen((f) => !f)}
            >
              {fullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
            <button
              className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700"
              onClick={handleClose}
            >
              <Check className="w-3.5 h-3.5" /> Done
            </button>
            <button className="btn-ghost p-1.5" title="Close" onClick={handleClose}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body: source editor + live preview */}
        <div className="flex flex-1 min-h-0 flex-col sm:flex-row">
          <div className="flex-1 min-w-0 min-h-0 flex flex-col border-b sm:border-b-0 sm:border-r border-gray-100 dark:border-gray-700">
            <textarea
              ref={textareaRef}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              spellCheck={false}
              className="flex-1 min-h-0 w-full p-3 font-mono text-sm outline-none resize-none bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100"
              placeholder="Mermaid diagram source…"
            />
          </div>
          <div className="flex-1 min-w-0 min-h-0 overflow-auto bg-gray-50 dark:bg-gray-900 p-3">
            <MermaidView source={source} interactive={false} />
          </div>
        </div>

        {/* Node-link insertion */}
        <div className="px-3 py-2 border-t border-gray-100 dark:border-gray-700 flex flex-wrap items-center gap-2 text-sm">
          {linksSupported ? (
            <>
              <input
                value={nodeId}
                onChange={(e) => setNodeId(e.target.value)}
                placeholder="Node id (e.g. A)"
                className="w-32 text-xs px-2 py-1.5 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 outline-none focus:border-blue-400"
              />
              <button
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
                disabled={!nodeId.trim()}
                onClick={() => setShowNotePicker(true)}
              >
                <FileText className="w-3.5 h-3.5" /> Link to note…
              </button>
              <input
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://…"
                className="w-48 text-xs px-2 py-1.5 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 outline-none focus:border-blue-400"
              />
              <button
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
                disabled={!nodeId.trim() || !urlInput.trim()}
                onClick={handleLinkToUrl}
              >
                <Link2 className="w-3.5 h-3.5" /> Link to URL
              </button>
            </>
          ) : (
            <p className="text-xs text-gray-400">
              {kind === 'mindmap'
                ? <>Mermaid mind maps don't support clickable node links yet (<a className="underline" href="https://github.com/mermaid-js/mermaid/issues/4099" target="_blank" rel="noopener noreferrer">mermaid-js/mermaid#4099</a>).</>
                : `${DIAGRAM_KIND_LABELS[kind]} diagrams don't support node links.`}
            </p>
          )}
        </div>
      </div>

      {showNotePicker && (
        <NotePickerModal
          onSelect={(id, title) => handleLinkToNote(id, title)}
          onClose={() => setShowNotePicker(false)}
        />
      )}
    </div>,
    document.body,
  )
}
