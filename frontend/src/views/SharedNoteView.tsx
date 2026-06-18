import { useState, useEffect, useRef, Component } from 'react'
import type { ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { Globe, Printer } from 'lucide-react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/mantine/style.css'
import '@blocknote/core/fonts/inter.css'
import type { PartialBlock } from '@blocknote/core'
import { noteSchema } from '@/blocks/childNoteBlock'
import DocumentOutline from '@/components/DocumentOutline'
import { sharedApi, type SharedNote } from '@/api/shared'
import { applyThemeToDom } from '@/stores/settings'

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function parseContent(content: string): PartialBlock[] {
  try {
    const blocks = JSON.parse(content)
    return Array.isArray(blocks) && blocks.length > 0 ? blocks as PartialBlock[] : [{ type: 'paragraph' }]
  } catch {
    return [{ type: 'paragraph' }]
  }
}

function handlePrint() {
  const style = document.createElement('style')
  style.setAttribute('media', 'print')
  // The shared view lives inside a position:fixed, overflow:auto container, which
  // makes browsers print only the first viewport-worth of content. Neutralise the
  // fixed positioning and any clipping overflow so the whole note flows across pages.
  style.textContent = `
    @page { margin: 5mm; }
    .no-print { display: none !important; }
    html, body { background: white; color: black; margin: 0; padding: 0; height: auto; min-height: auto; }
    .shared-root { display: block !important; position: static !important; overflow: visible !important; height: auto !important; inset: auto !important; }
    .shared-body { display: block !important; }
    .shared-scroll { overflow: visible !important; height: auto !important; }
    .shared-content { overflow: visible !important; background: transparent !important; border: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
    .bn-container, .bn-editor { overflow: visible !important; height: auto !important; min-height: auto !important; page-break-inside: auto; }
    img { page-break-inside: avoid; }
    * { text-shadow: none !important; box-shadow: none !important; }
  `
  document.head.appendChild(style)
  window.print()
  setTimeout(() => document.head.removeChild(style), 1000)
}

class EditorErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  render() {
    if (this.state.hasError)
      return <div className="p-8 text-gray-500 text-sm">This note could not be rendered.</div>
    return this.props.children
  }
}

// The loaded note: a document outline on the left and the note content in a
// scrollable column. Rendered only once `note` is available so the read-only
// editor can be created with its content (and the outline derived from it)
// directly, without a hydration step.
function SharedNoteBody({ note }: { note: SharedNote }) {
  const editor = useCreateBlockNote({ schema: noteSchema, initialContent: parseContent(note.content) as never })
  const scrollRef = useRef<HTMLDivElement>(null)
  const editorTheme: 'light' | 'dark' = note.theme ? note.theme.mode : 'light'

  return (
    <div className="shared-body flex flex-1 min-h-0 flex-col sm:flex-row">
      {/* Document outline (left) */}
      <DocumentOutline
        editor={editor}
        scrollContainerRef={scrollRef}
        storageKey="shared-outline-open"
        scrollOffset={24}
      />

      {/* Scrollable note content */}
      <div ref={scrollRef} className="shared-scroll flex-1 min-w-0 overflow-y-auto">
        <main className="w-full md:w-4/5 mx-auto px-4 py-8">
          {/* Title */}
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-4 leading-tight">
            {note.title || 'Untitled'}
          </h1>

          {/* Author + metadata */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-4 text-sm text-gray-500 dark:text-gray-400">
            <div className="flex items-center gap-2">
              {note.author_avatar_url ? (
                <img
                  src={note.author_avatar_url}
                  alt={note.author_username}
                  className="w-6 h-6 rounded-full object-cover"
                />
              ) : (
                <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center text-xs font-semibold text-blue-600">
                  {note.author_username.charAt(0).toUpperCase()}
                </div>
              )}
              <span className="font-medium text-gray-700 dark:text-gray-300">{note.author_username}</span>
            </div>
            <span>Created {formatDate(note.created_at)}</span>
            <span>Updated {formatDate(note.modified_at)}</span>
          </div>

          {/* Tags */}
          {note.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-6">
              {note.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}

          <div className="border-t border-gray-100 dark:border-gray-700 mb-6" />

          {/* Note content */}
          <div className="shared-content overflow-hidden">
            <EditorErrorBoundary>
              <BlockNoteView editor={editor} editable={false} theme={editorTheme} />
            </EditorErrorBoundary>
          </div>

          <p className="text-center text-xs text-gray-400 dark:text-gray-500 mt-8">
            Shared with Gecko Notes
          </p>
        </main>
      </div>
    </div>
  )
}

export default function SharedNoteView() {
  const { token } = useParams<{ token: string }>()
  const [note, setNote] = useState<SharedNote | null>(null)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!token) { setNotFound(true); return }
    sharedApi.get(token)
      .then((res) => {
        setNote(res.data)
        applyThemeToDom(res.data.theme ?? null)
      })
      .catch(() => setNotFound(true))
    return () => { applyThemeToDom(null) }
  }, [token])

  if (notFound) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <Globe className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <h1 className="text-xl font-semibold text-gray-700 mb-2">Note not found</h1>
          <p className="text-gray-500 text-sm">This note is no longer shared or does not exist.</p>
        </div>
      </div>
    )
  }

  if (!note) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <svg className="animate-spin w-6 h-6 text-gray-400" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
      </div>
    )
  }

  return (
    <div className="shared-root flex flex-col" style={{ position: 'fixed', inset: 0, overflow: 'hidden', zIndex: 40 }}>
      {/* Fixed theme background layer — same as App.tsx */}
      <div
        aria-hidden="true"
        className="no-print"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: -1,
          background: 'var(--theme-bg, #f9fafb)',
          backgroundSize: 'var(--theme-bg-size, cover)',
          backgroundPosition: 'center',
          filter: 'var(--theme-bg-filter, none)',
        }}
      />

      {/* Header */}
      <header className="no-print shrink-0 border-b border-gray-100 dark:border-gray-700 z-10" style={{ background: 'rgba(var(--glass-rgb,255,255,255), var(--glass-opacity,0.85))', backdropFilter: 'blur(var(--glass-blur,8px))' }}>
        <div className="w-full md:w-4/5 mx-auto px-4 py-3 flex items-center justify-between">
          <span className="font-semibold text-gray-800 dark:text-gray-100 text-sm tracking-tight">Gecko Notes</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handlePrint}
              title="Print this note"
              aria-label="Print this note"
              className="flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 px-2.5 py-1 rounded-full transition-colors"
            >
              <Printer className="w-3.5 h-3.5" />
              Print
            </button>
            <span className="flex items-center gap-1.5 text-xs font-medium text-green-600 bg-green-50 border border-green-200 px-2.5 py-1 rounded-full">
              <Globe className="w-3.5 h-3.5" />
              Shared note
            </span>
          </div>
        </div>
      </header>

      {/* Outline + content */}
      <SharedNoteBody note={note} />
    </div>
  )
}
