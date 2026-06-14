import { useState, useEffect, useRef } from 'react'
import { Search, FileText, X } from 'lucide-react'
import { notesApi, type NoteListItem } from '@/api/notes'

function relativeDate(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)
  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays} days ago`
  return new Date(dateStr).toLocaleDateString()
}

interface Props {
  onSelect: (noteId: string, noteTitle: string) => void
  onClose: () => void
}

export default function NotePickerModal({ onSelect, onClose }: Props) {
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<NoteListItem[]>([])
  const [loading, setLoading] = useState(false)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    void fetchNotes('')
  }, [])

  async function fetchNotes(q: string) {
    setLoading(true)
    try {
      const res = await notesApi.list({ search: q, limit: 20 })
      setResults(res.data)
    } catch {
      setResults([])
    } finally {
      setLoading(false)
    }
  }

  function handleSearch(q: string) {
    setSearch(q)
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => void fetchNotes(q), 300)
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-md mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 dark:border-gray-700">
          <Search className="w-4 h-4 text-gray-400 shrink-0" />
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Search notes…"
            className="flex-1 text-sm bg-transparent outline-none text-gray-900 dark:text-gray-100 placeholder-gray-400"
          />
          <button className="btn-ghost p-1" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto max-h-72">
          {loading && (
            <p className="text-sm text-gray-400 px-4 py-6 text-center">Searching…</p>
          )}
          {!loading && results.length === 0 && (
            <p className="text-sm text-gray-400 px-4 py-6 text-center">
              {search ? 'No notes found.' : 'Start typing to search notes.'}
            </p>
          )}
          {!loading && results.map((note) => (
            <button
              key={note.id}
              className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700 text-left transition-colors"
              onClick={() => onSelect(note.id, note.title || 'Untitled')}
            >
              <FileText className="w-4 h-4 text-gray-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                  {note.title || 'Untitled'}
                </p>
                {note.content_preview && (
                  <p className="text-xs text-gray-400 truncate">{note.content_preview}</p>
                )}
              </div>
              <span className="text-xs text-gray-400 shrink-0">{relativeDate(note.modified_at)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
