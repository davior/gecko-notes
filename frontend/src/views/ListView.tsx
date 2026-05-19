import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Search, Settings, Plus, ArrowUpDown, LayoutList, LayoutGrid, X, Copy } from 'lucide-react'
import NoteCard from '@/components/NoteCard'
import AIBar from '@/components/AIBar'
import UserAvatar from '@/components/UserAvatar'
import ThemePicker from '@/components/ThemePicker'
import AIProviderPicker from '@/components/AIProviderPicker'
import { useNotesStore } from '@/stores/notes'
import { useCategoriesStore } from '@/stores/categories'
import { useSettingsStore } from '@/stores/settings'

type ViewMode = 'list' | 'card'

function storedViewMode(): ViewMode {
  return (localStorage.getItem('viewMode') as ViewMode) ?? 'list'
}

export default function ListView() {
  const navigate = useNavigate()
  const { notes, loading, hasMore, loadNotes, loadMore, pinNote } = useNotesStore()
  const getCategoryById = useCategoriesStore((s) => s.getCategoryById)
  const categories = useCategoriesStore((s) => s.categories)
  const defaultSortOrder = useSettingsStore((s) => s.defaultSortOrder)

  const [searchQuery, setSearchQuery] = useState('')
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null)
  const [sortOrder, setSortOrder] = useState<'modified_at' | 'created_at'>(
    (defaultSortOrder as 'modified_at' | 'created_at') || 'modified_at',
  )
  const [viewMode, setViewMode] = useState<ViewMode>(storedViewMode)
  const [aiResult, setAiResult] = useState('')
  const sentinelRef = useRef<HTMLDivElement>(null)
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  const buildParams = useCallback(() => ({
    sort: sortOrder,
    order: 'desc' as const,
    category_id: activeCategoryId ?? undefined,
    search: searchQuery || undefined,
  }), [sortOrder, activeCategoryId, searchQuery])

  useEffect(() => {
    loadNotes(buildParams(), true)
  }, [sortOrder, activeCategoryId])

  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current)
    searchDebounce.current = setTimeout(() => loadNotes(buildParams(), true), 300)
    return () => { if (searchDebounce.current) clearTimeout(searchDebounce.current) }
  }, [searchQuery])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading) {
          loadMore(buildParams())
        }
      },
      { threshold: 0.1 },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, loading, buildParams])

  function toggleSort() {
    const next = sortOrder === 'modified_at' ? 'created_at' : 'modified_at'
    setSortOrder(next)
  }

  function toggleView() {
    const next: ViewMode = viewMode === 'list' ? 'card' : 'list'
    localStorage.setItem('viewMode', next)
    setViewMode(next)
  }

  async function copyAIResult() {
    await navigator.clipboard.writeText(aiResult)
  }

  const pinnedNotes = notes.filter((n) => n.is_pinned)
  const unpinnedNotes = notes.filter((n) => !n.is_pinned)

  const gridClass = viewMode === 'card'
    ? 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3'
    : 'space-y-3'

  function renderNotes(list: typeof notes) {
    return list.map((note) => (
      <NoteCard
        key={note.id}
        note={note}
        category={getCategoryById(note.category_id)}
        onClick={(id) => navigate(`/notes/${id}`)}
        onPin={pinNote}
        viewMode={viewMode}
      />
    ))
  }

  return (
    <div className="flex flex-col h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-3 shrink-0 no-print">
        <div className="flex items-center gap-3 mb-3">
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <span className="text-2xl">🦎</span>
            Gecko Notes
          </h1>
          <div className="flex-1" />
          <AIProviderPicker />
          <ThemePicker />
          <Link to="/settings" className="btn-ghost p-2">
            <Settings className="w-5 h-5" />
          </Link>
          <UserAvatar />
        </div>

        <div className="relative mb-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            type="text"
            placeholder="Search notes..."
            className="input pl-9 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 dark:placeholder-gray-400"
          />
        </div>

        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          <button
            className={`text-xs px-3 py-1.5 rounded-full border shrink-0 transition-colors ${activeCategoryId === null ? 'bg-gray-900 text-white border-gray-900 dark:bg-gray-100 dark:text-gray-900' : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600 hover:border-gray-400'}`}
            onClick={() => setActiveCategoryId(null)}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id}
              className="text-xs px-3 py-1.5 rounded-full border shrink-0 transition-colors dark:border-gray-600 dark:text-gray-300 dark:bg-gray-700"
              style={activeCategoryId === cat.id ? { backgroundColor: cat.color, borderColor: cat.color, color: 'white' } : {}}
              onClick={() => setActiveCategoryId((id) => id === cat.id ? null : cat.id)}
            >
              {cat.emoji} {cat.label}
            </button>
          ))}
          <div className="flex-1" />
          <button
            className="text-xs px-3 py-1.5 rounded-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-400 shrink-0 flex items-center gap-1 transition-colors"
            onClick={toggleSort}
          >
            <ArrowUpDown className="w-3 h-3" />
            {sortOrder === 'modified_at' ? 'Modified' : 'Created'}
          </button>
          <button
            className="text-xs px-3 py-1.5 rounded-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-400 shrink-0 flex items-center gap-1 transition-colors"
            title={viewMode === 'list' ? 'Switch to card view' : 'Switch to list view'}
            onClick={toggleView}
          >
            {viewMode === 'list' ? <LayoutGrid className="w-3 h-3" /> : <LayoutList className="w-3 h-3" />}
            {viewMode === 'list' ? 'Cards' : 'List'}
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-4">
        {loading && notes.length === 0 ? (
          <div className={gridClass}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className={`card dark:bg-gray-800 dark:border-gray-700 animate-pulse ${viewMode === 'card' ? 'h-52' : 'p-4'}`}>
                {viewMode === 'list' && <>
                  <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/3 mb-2" />
                  <div className="h-5 bg-gray-200 dark:bg-gray-700 rounded w-3/4 mb-2" />
                  <div className="h-3 bg-gray-100 dark:bg-gray-600 rounded w-full mb-1" />
                  <div className="h-3 bg-gray-100 dark:bg-gray-600 rounded w-2/3" />
                </>}
              </div>
            ))}
          </div>
        ) : notes.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-5xl mb-4">📝</p>
            <p className="text-gray-500 dark:text-gray-400 text-lg font-medium mb-1">No notes yet</p>
            <p className="text-gray-400 dark:text-gray-500 text-sm mb-6">Create your first note to get started</p>
            <Link to="/notes/new" className="btn-primary inline-flex">
              <Plus className="w-4 h-4" /> New Note
            </Link>
          </div>
        ) : (
          <>
            {pinnedNotes.length > 0 && (
              <>
                <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider px-1 mb-2">Pinned</p>
                <div className={`${gridClass} mb-4`}>
                  {renderNotes(pinnedNotes)}
                </div>
                {unpinnedNotes.length > 0 && (
                  <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider px-1 mb-2">Notes</p>
                )}
              </>
            )}
            <div className={gridClass}>
              {renderNotes(unpinnedNotes)}
            </div>
            <div ref={sentinelRef} className="h-2" />
            {loading && (
              <div className="text-center py-4">
                <svg className="animate-spin w-5 h-5 text-gray-400 mx-auto" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
              </div>
            )}
          </>
        )}
      </main>

      {/* AI result pane */}
      {aiResult && (
        <div className="shrink-0 mx-4 mb-2 rounded-xl border border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-blue-700 dark:text-blue-400 uppercase tracking-wide">AI Response</span>
            <div className="flex items-center gap-2">
              <button
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
                onClick={copyAIResult}
              >
                <Copy className="w-3 h-3" />
                Copy
              </button>
              <button
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                onClick={() => setAiResult('')}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
          <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap max-h-40 overflow-y-auto">{aiResult}</p>
        </div>
      )}

      <div className="shrink-0 no-print">
        <AIBar
          getNoteContext={() => ''}
          getSelectedText={() => ''}
          onResult={(text) => setAiResult(text)}
          placeholder="Ask AI a question…"
        />
      </div>

      <Link
        to="/notes/new"
        className="fixed bottom-20 right-6 w-12 h-12 bg-blue-600 hover:bg-blue-700 text-white rounded-full shadow-lg flex items-center justify-center transition-colors no-print"
        aria-label="New note"
      >
        <Plus className="w-6 h-6" />
      </Link>
    </div>
  )
}
