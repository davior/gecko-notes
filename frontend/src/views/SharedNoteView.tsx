import { useState, useEffect, Component } from 'react'
import type { ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { Globe } from 'lucide-react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/mantine/style.css'
import '@blocknote/core/fonts/inter.css'
import type { PartialBlock } from '@blocknote/core'
import { noteSchema } from '@/blocks/childNoteBlock'
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

class EditorErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  render() {
    if (this.state.hasError)
      return <div className="p-8 text-gray-500 text-sm">This note could not be rendered.</div>
    return this.props.children
  }
}

function ReadOnlyEditor({ content, editorTheme }: { content: string; editorTheme: 'light' | 'dark' }) {
  const editor = useCreateBlockNote({ schema: noteSchema, initialContent: parseContent(content) as never })
  return (
    <EditorErrorBoundary>
      <BlockNoteView editor={editor} editable={false} theme={editorTheme} />
    </EditorErrorBoundary>
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

  const editorTheme: 'light' | 'dark' = note?.theme ? note.theme.mode : 'light'

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
    <div style={{ position: 'fixed', inset: 0, overflowY: 'auto', zIndex: 40 }}>
      {/* Fixed theme background layer — same as App.tsx */}
      <div
        aria-hidden="true"
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
      <header className="border-b border-gray-100 dark:border-gray-700 sticky top-0 z-10" style={{ background: 'rgba(var(--glass-rgb,255,255,255), var(--glass-opacity,0.85))', backdropFilter: 'blur(var(--glass-blur,8px))' }}>
        <div className="w-full md:w-4/5 mx-auto px-4 py-3 flex items-center justify-between">
          <span className="font-semibold text-gray-800 dark:text-gray-100 text-sm tracking-tight">Gecko Notes</span>
          <span className="flex items-center gap-1.5 text-xs font-medium text-green-600 bg-green-50 border border-green-200 px-2.5 py-1 rounded-full">
            <Globe className="w-3.5 h-3.5" />
            Shared note
          </span>
        </div>
      </header>

      {/* Content */}
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
          <ReadOnlyEditor content={note.content} editorTheme={editorTheme} />
        </div>

        <p className="text-center text-xs text-gray-400 dark:text-gray-500 mt-8">
          Shared with Gecko Notes
        </p>
      </main>
    </div>
  )
}
