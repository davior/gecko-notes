import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { Search, Settings, Plus, ArrowUpDown, LayoutList, LayoutGrid, X, Copy, FolderPlus } from 'lucide-react'
import {
  DndContext, PointerSensor, TouchSensor, useSensor, useSensors, useDraggable,
  type DragEndEvent,
} from '@dnd-kit/core'
import NoteCard from '@/components/NoteCard'
import FolderCard from '@/components/FolderCard'
import FolderBreadcrumb from '@/components/FolderBreadcrumb'
import FolderPickerModal from '@/components/FolderPickerModal'
import AIBar from '@/components/AIBar'
import UserAvatar from '@/components/UserAvatar'
import { useNotesStore } from '@/stores/notes'
import { useFoldersStore } from '@/stores/folders'
import { useCategoriesStore } from '@/stores/categories'
import { useSettingsStore } from '@/stores/settings'
import type { NoteListItem } from '@/api/notes'
import type { Folder } from '@/api/folders'

type ViewMode = 'list' | 'card'

function storedViewMode(): ViewMode {
  return (localStorage.getItem('viewMode') as ViewMode) ?? 'list'
}

// Wrap a NoteCard so it can be dragged onto a folder.
function DraggableNote({ note, children }: { note: NoteListItem; children: React.ReactNode }) {
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: `note-drag:${note.id}`,
    data: { type: 'note', noteId: note.id },
  })
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} className={isDragging ? 'opacity-50' : ''}>
      {children}
    </div>
  )
}

export default function ListView() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const folderId = searchParams.get('folder')

  const { notes, loading, hasMore, loadNotes, loadMore, pinNote } = useNotesStore()
  const foldersStore = useFoldersStore()
  const { breadcrumb, subfolders } = foldersStore
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
  const [moveTarget, setMoveTarget] = useState<{ type: 'note' | 'folder'; id: string } | null>(null)
  const [toast, setToast] = useState('')
  const sentinelRef = useRef<HTMLDivElement>(null)
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  )

  const buildParams = useCallback(() => ({
    sort: sortOrder,
    order: 'desc' as const,
    category_id: activeCategoryId ?? undefined,
    in_folder: true,
    folder_id: folderId ?? undefined,
    search: searchQuery || undefined,
  }), [sortOrder, activeCategoryId, searchQuery, folderId])

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(''), 3000)
  }

  // Reload notes + folder chrome when the folder, sort, or category changes.
  useEffect(() => {
    loadNotes(buildParams(), true)
    foldersStore.loadContents(folderId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortOrder, activeCategoryId, folderId])

  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current)
    searchDebounce.current = setTimeout(() => loadNotes(buildParams(), true), 300)
    return () => { if (searchDebounce.current) clearTimeout(searchDebounce.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setSortOrder((o) => (o === 'modified_at' ? 'created_at' : 'modified_at'))
  }

  function toggleView() {
    const next: ViewMode = viewMode === 'list' ? 'card' : 'list'
    localStorage.setItem('viewMode', next)
    setViewMode(next)
  }

  function openFolder(id: string | null) {
    if (id) setSearchParams({ folder: id })
    else setSearchParams({})
  }

  async function copyAIResult() {
    await navigator.clipboard.writeText(aiResult)
  }

  async function handleNewFolder() {
    const name = window.prompt('New folder name')?.trim()
    if (!name) return
    await foldersStore.createFolder({ name, parent_folder_id: folderId })
  }

  async function handleRenameFolder(folder: Folder) {
    const name = window.prompt('Rename folder', folder.name)?.trim()
    if (!name || name === folder.name) return
    await foldersStore.renameFolder(folder.id, name)
  }

  async function handleDeleteFolder(folder: Folder) {
    if (!window.confirm(`Delete folder "${folder.name}"? Its notes and subfolders move up one level.`)) return
    await foldersStore.deleteFolder(folder.id)
    loadNotes(buildParams(), true)  // re-parented notes may now appear here
  }

  async function handleMoveSelect(destFolderId: string | null) {
    if (!moveTarget) return
    const target = moveTarget
    setMoveTarget(null)
    try {
      if (target.type === 'note') {
        await foldersStore.moveNoteToFolder(target.id, destFolderId)
      } else {
        await foldersStore.moveFolder(target.id, destFolderId)
      }
      loadNotes(buildParams(), true)
      foldersStore.loadContents(folderId)
    } catch {
      showToast('Could not move item there.')
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over) return
    const overId = String(over.id)
    if (!overId.startsWith('folder-drop:')) return
    const destFolderId = overId.slice('folder-drop:'.length)
    const data = active.data.current as { type: string; noteId?: string; folderId?: string } | undefined
    if (!data) return
    try {
      if (data.type === 'note' && data.noteId) {
        await foldersStore.moveNoteToFolder(data.noteId, destFolderId)
        loadNotes(buildParams(), true)
      } else if (data.type === 'folder' && data.folderId && data.folderId !== destFolderId) {
        await foldersStore.moveFolder(data.folderId, destFolderId)
        foldersStore.loadContents(folderId)
      }
    } catch {
      showToast('Could not move item there.')
    }
  }

  const pinnedNotes = notes.filter((n) => n.is_pinned)
  const unpinnedNotes = notes.filter((n) => !n.is_pinned)

  const gridClass = viewMode === 'card'
    ? 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3'
    : 'space-y-3'

  function renderNotes(list: NoteListItem[]) {
    return list.map((note) => (
      <DraggableNote key={note.id} note={note}>
        <NoteCard
          note={note}
          category={getCategoryById(note.category_id)}
          onClick={(id) => navigate(`/notes/${id}`)}
          onPin={pinNote}
          onMove={(id) => setMoveTarget({ type: 'note', id })}
          viewMode={viewMode}
        />
      </DraggableNote>
    ))
  }

  function renderFolders() {
    if (subfolders.length === 0) return null
    return (
      <div className={`${gridClass} mb-4`}>
        {subfolders.map((folder) => (
          <FolderCard
            key={folder.id}
            folder={folder}
            viewMode={viewMode}
            onOpen={(id) => openFolder(id)}
            onMove={(f) => setMoveTarget({ type: 'folder', id: f.id })}
            onRename={handleRenameFolder}
            onDelete={handleDeleteFolder}
          />
        ))}
      </div>
    )
  }

  const newNotePath = folderId ? `/notes/new?folder=${folderId}` : '/notes/new'

  return (
    <div className="flex flex-col h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-3 shrink-0 no-print">
        <div className="flex items-center gap-3 mb-3">
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <span className="text-2xl">🦎</span>
            Gecko Notes
          </h1>
          <div className="flex-1" />
          <Link to="/settings" className="btn-ghost p-2">
            <Settings className="w-5 h-5" />
          </Link>
          <UserAvatar />
        </div>

        <FolderBreadcrumb breadcrumb={breadcrumb} onNavigate={openFolder} />

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

        <div className="flex items-center gap-2 overflow-x-auto pt-[0.2em] pb-1">
          <button
            className={`text-xs px-3 py-1.5 rounded-full border shrink-0 transition-all ${
              activeCategoryId === null
                ? 'bg-gray-900 text-white border-gray-900 dark:bg-gray-100 dark:text-gray-900 ring-1 ring-offset-1 ring-gray-500 dark:ring-gray-400 shadow-none'
                : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600 hover:border-gray-400 dark:hover:border-gray-400'
            }`}
            onClick={() => setActiveCategoryId(null)}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id}
              className={`text-xs px-3 py-1.5 rounded-full border shrink-0 transition-all dark:border-gray-600 dark:text-gray-300 dark:bg-gray-700 ${
                activeCategoryId === cat.id
                  ? 'shadow-none'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-600 hover:border-gray-400 dark:hover:border-gray-500'
              }`}
              style={
                activeCategoryId === cat.id
                  ? { backgroundColor: cat.color, borderColor: cat.color, color: 'white', outline: `1.5px solid ${cat.color}`, outlineOffset: '2px' }
                  : {}
              }
              onClick={() => setActiveCategoryId((id) => id === cat.id ? null : cat.id)}
            >
              {cat.emoji} {cat.label}
            </button>
          ))}
          <div className="flex-1" />
          <button
            className="text-xs px-3 py-1.5 rounded-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 hover:border-gray-400 dark:hover:border-gray-400 shrink-0 flex items-center gap-1 transition-all"
            onClick={handleNewFolder}
          >
            <FolderPlus className="w-3 h-3" />
            New folder
          </button>
          <button
            className="text-xs px-3 py-1.5 rounded-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 hover:border-gray-400 dark:hover:border-gray-400 shrink-0 flex items-center gap-1 transition-all"
            onClick={toggleSort}
          >
            <ArrowUpDown className="w-3 h-3" />
            {sortOrder === 'modified_at' ? 'Modified' : 'Created'}
          </button>
          <button
            className="text-xs px-3 py-1.5 rounded-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 hover:border-gray-400 dark:hover:border-gray-400 shrink-0 flex items-center gap-1 transition-all"
            title={viewMode === 'list' ? 'Switch to card view' : 'Switch to list view'}
            onClick={toggleView}
          >
            {viewMode === 'list' ? <LayoutGrid className="w-3 h-3" /> : <LayoutList className="w-3 h-3" />}
            {viewMode === 'list' ? 'Cards' : 'List'}
          </button>
        </div>
      </header>

      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <main className="flex-1 overflow-y-auto px-4 py-4">
          {loading && notes.length === 0 && subfolders.length === 0 ? (
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
          ) : notes.length === 0 && subfolders.length === 0 ? (
            <div className="text-center py-20">
              <p className="text-5xl mb-4">📝</p>
              <p className="text-gray-500 dark:text-gray-400 text-lg font-medium mb-1">{folderId ? 'This folder is empty' : 'No notes yet'}</p>
              <p className="text-gray-400 dark:text-gray-500 text-sm mb-6">Create a note or folder to get started</p>
              <Link to={newNotePath} className="btn-primary inline-flex">
                <Plus className="w-4 h-4" /> New Note
              </Link>
            </div>
          ) : (
            <>
              {renderFolders()}
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
      </DndContext>

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

      {toast && (
        <div className="fixed bottom-32 left-1/2 -translate-x-1/2 z-50 bg-gray-900 text-white text-sm px-4 py-2 rounded-lg shadow-lg">
          {toast}
        </div>
      )}

      {moveTarget && (
        <FolderPickerModal
          title={moveTarget.type === 'folder' ? 'Move folder to' : 'Move note to'}
          disabledIds={moveTarget.type === 'folder' ? new Set([moveTarget.id]) : undefined}
          onSelect={handleMoveSelect}
          onClose={() => setMoveTarget(null)}
        />
      )}

      <Link
        to={newNotePath}
        className="fixed bottom-20 right-6 w-12 h-12 bg-blue-600 hover:bg-blue-700 text-white rounded-full shadow-lg flex items-center justify-center transition-colors no-print"
        aria-label="New note"
      >
        <Plus className="w-6 h-6" />
      </Link>
    </div>
  )
}
