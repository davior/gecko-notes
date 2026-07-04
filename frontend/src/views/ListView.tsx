import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import {
  Search, Plus, ArrowUpDown, LayoutList, LayoutGrid, X, FolderPlus, FolderInput, Trash2,
  ChevronDown, Upload, CheckCircle2, Circle, Loader2,
} from 'lucide-react'
import {
  DndContext, DragOverlay, PointerSensor, TouchSensor, useSensor, useSensors, useDraggable,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { useCreateBlockNote } from '@blocknote/react'
import { Folder as FolderIcon } from 'lucide-react'
import NoteCard from '@/components/NoteCard'
import FolderIconBar from '@/components/FolderIconBar'
import FolderBreadcrumb from '@/components/FolderBreadcrumb'
import FolderPickerModal from '@/components/FolderPickerModal'
import AIConversationPanel from '@/components/AIConversationPanel'
import { noteSchema } from '@/blocks/childNoteBlock'
import UserAvatar from '@/components/UserAvatar'
import { useNotesStore } from '@/stores/notes'
import { useFoldersStore } from '@/stores/folders'
import { useCategoriesStore } from '@/stores/categories'
import { useSettingsStore } from '@/stores/settings'
import { parseMarkdownFrontmatter } from '@/utils/markdown'
import { notesApi } from '@/api/notes'
import type { NoteListItem } from '@/api/notes'
import type { Folder } from '@/api/folders'
import { generateNoteFilter } from '@/services/smartQuery'

type ViewMode = 'list' | 'card'

function storedViewMode(): ViewMode {
  return (localStorage.getItem('viewMode') as ViewMode) ?? 'list'
}

// Instant, no-DB filter over notes already loaded for the current folder view — the
// "no Enter" search tier. Same substring match (title + body) the backend previously
// did server-side, just client-side and scoped to whatever's already fetched.
function filterLocally(list: NoteListItem[], query: string): NoteListItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return list
  return list.filter((n) => n.title.toLowerCase().includes(q) || n.content_preview.toLowerCase().includes(q))
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

  const { notes, loading, hasMore, loadNotes, loadMore, pinNote, deleteNote, createNote } = useNotesStore()
  const foldersStore = useFoldersStore()
  const { breadcrumb, subfolders } = foldersStore
  const getCategoryById = useCategoriesStore((s) => s.getCategoryById)
  const categories = useCategoriesStore((s) => s.categories)
  const defaultSortOrder = useSettingsStore((s) => s.defaultSortOrder)
  const aiService = useSettingsStore((s) => s.aiService)

  const [searchQuery, setSearchQuery] = useState('')
  // Results of the last Enter-triggered deep search (AI-generated filter, or the plain
  // keyword fallback), spanning all folders. null ⇒ showing the normal folder-scoped
  // view (optionally locally filtered by searchQuery as-you-type).
  const [deepResults, setDeepResults] = useState<NoteListItem[] | null>(null)
  const [deepLoading, setDeepLoading] = useState(false)
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null)
  const [sortOrder, setSortOrder] = useState<'modified_at' | 'created_at'>(
    (defaultSortOrder as 'modified_at' | 'created_at') || 'modified_at',
  )
  const [viewMode, setViewMode] = useState<ViewMode>(storedViewMode)
  const [panelOpen, setPanelOpen] = useState(false)
  const [fabMenuOpen, setFabMenuOpen] = useState(false)
  const [activeDrag, setActiveDrag] = useState<{ type: 'note' | 'folder'; label: string } | null>(null)
  const [moveTarget, setMoveTarget] = useState<{ id: string } | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [noteMoveOpen, setNoteMoveOpen] = useState(false)
  const [noteDeleteOpen, setNoteDeleteOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [pinnedCollapsed, setPinnedCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('pinnedCollapsed') === 'true' } catch { return false }
  })
  const [notesCollapsed, setNotesCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('notesCollapsed') === 'true' } catch { return false }
  })
  const sentinelRef = useRef<HTMLDivElement>(null)
  const categoryScrollRef = useRef<HTMLDivElement>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)

  // Headless BlockNote editor: powers the list-view AI Assistant's markdown↔blocks
  // conversion for context building and plan execution (there is no on-screen editor here).
  const aiEditor = useCreateBlockNote({ schema: noteSchema })
  const defaultCategoryId = categories[0]?.id ?? ''

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
  }), [sortOrder, activeCategoryId, folderId])

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(''), 3000)
  }

  // Reload notes + folder chrome when the folder, sort, or category changes. Also
  // leaves deep-search-results mode — those controls belong to normal browsing.
  useEffect(() => {
    clearSelection()
    setDeepResults(null)
    loadNotes(buildParams(), true)
    foldersStore.loadContents(folderId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortOrder, activeCategoryId, folderId])

  // As-you-type filtering is purely local (see filterLocally/displayNotes below) — no
  // network call, so no debounce. Clearing the box back to '' also drops deep-search
  // results, since the X button and backspacing-to-empty both just set searchQuery('').
  useEffect(() => {
    clearSelection()
    if (searchQuery === '') setDeepResults(null)
  }, [searchQuery])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading && deepResults === null) {
          loadMore(buildParams())
        }
      },
      { threshold: 0.1 },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, loading, buildParams, deepResults])

  useEffect(() => {
    const el = categoryScrollRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      if (e.deltaY === 0) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  function toggleSort() {
    setSortOrder((o) => (o === 'modified_at' ? 'created_at' : 'modified_at'))
  }

  // The "Enter" search tier: always tries the AI-generated structured filter (any
  // query length or syntax — no word-count/advanced-syntax gating), searching across
  // ALL of the user's notes. Falls back to the existing global keyword search when no
  // AI provider is configured, or if generation/execution fails for any reason.
  async function runDeepSearch() {
    const query = searchQuery.trim()
    if (!query) { setDeepResults(null); return }
    clearSelection()
    setDeepLoading(true)
    try {
      if (aiService) {
        try {
          const filter = await generateNoteFilter(aiService, { query, categories })
          const result = await notesApi.smartSearch(filter)
          setDeepResults(result.data)
          return
        } catch {
          // AI filter generation or execution failed — fall through to keyword search.
        }
      }
      const result = await notesApi.list({
        search: query,
        sort: sortOrder,
        order: 'desc',
        category_id: activeCategoryId ?? undefined,
      })
      setDeepResults(result.data)
    } catch {
      showToast('Search failed. Please try again.')
    } finally {
      setDeepLoading(false)
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function clearSelection() {
    setSelectedIds(new Set())
  }

  async function handleShareClick(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      showToast('Shared link copied to clipboard!')
    } catch {
      showToast('Failed to copy link')
    }
  }

  function toggleView() {
    const next: ViewMode = viewMode === 'list' ? 'card' : 'list'
    localStorage.setItem('viewMode', next)
    setViewMode(next)
  }

  function togglePinnedCollapsed() {
    const next = !pinnedCollapsed
    setPinnedCollapsed(next)
    localStorage.setItem('pinnedCollapsed', String(next))
  }

  function toggleNotesCollapsed() {
    const next = !notesCollapsed
    setNotesCollapsed(next)
    localStorage.setItem('notesCollapsed', String(next))
  }

  function openFolder(id: string | null) {
    if (id) setSearchParams({ folder: id })
    else setSearchParams({})
  }

  async function handleNewFolder() {
    const name = window.prompt('New folder name')?.trim()
    if (!name) return
    await foldersStore.createFolder({ name, parent_folder_id: folderId })
  }

  function titleFromFilename(filename: string): string {
    return filename.replace(/\.(md|markdown)$/i, '').trim() || 'Untitled'
  }

  // Imports one or more .md files as new notes in the currently open folder.
  async function handleImportMarkdown(files: FileList | null) {
    if (!files || files.length === 0) return
    setImporting(true)
    let imported = 0
    let failed = 0
    try {
      for (const file of Array.from(files)) {
        try {
          const raw = await file.text()
          const { title, tags, body } = parseMarkdownFrontmatter(raw)
          const blocks = await aiEditor.tryParseMarkdownToBlocks(body)
          await createNote({
            title: title || titleFromFilename(file.name),
            content: JSON.stringify(blocks.length > 0 ? blocks : [{ type: 'paragraph' }]),
            category_id: defaultCategoryId,
            folder_id: folderId,
            tags,
          })
          imported++
        } catch {
          failed++
        }
      }
    } finally {
      setImporting(false)
      if (importInputRef.current) importInputRef.current.value = ''
      loadNotes(buildParams(), true)
      showToast(
        failed === 0
          ? `Imported ${imported} note${imported !== 1 ? 's' : ''}`
          : `Imported ${imported} note${imported !== 1 ? 's' : ''}, ${failed} failed`,
      )
    }
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
      await foldersStore.moveFolder(target.id, destFolderId)
      loadNotes(buildParams(), true)
      foldersStore.loadContents(folderId)
    } catch {
      showToast('Could not move item there.')
    }
  }

  async function handleBulkMoveSelect(destFolderId: string | null) {
    setNoteMoveOpen(false)
    const ids = Array.from(selectedIds)
    try {
      await Promise.all(ids.map((id) => foldersStore.moveNoteToFolder(id, destFolderId)))
    } catch {
      showToast('Could not move some notes there.')
    } finally {
      clearSelection()
      loadNotes(buildParams(), true)
      foldersStore.loadContents(folderId)
    }
  }

  async function handleBulkDelete() {
    const ids = Array.from(selectedIds)
    setNoteDeleteOpen(false)
    try {
      await Promise.all(ids.map((id) => deleteNote(id)))
    } catch {
      showToast('Could not delete some notes.')
    } finally {
      clearSelection()
    }
  }

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as { type: string; noteId?: string; folderId?: string } | undefined
    if (!data) return
    if (data.type === 'folder' && data.folderId) {
      const folder = subfolders.find((f) => f.id === data.folderId)
      setActiveDrag({ type: 'folder', label: folder?.name ?? '' })
    } else if (data.type === 'note' && data.noteId) {
      const note = notes.find((n) => n.id === data.noteId)
      setActiveDrag({ type: 'note', label: note?.title || 'Untitled' })
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveDrag(null)
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
        setSelectedIds((prev) => {
          if (!prev.has(data.noteId as string)) return prev
          const next = new Set(prev)
          next.delete(data.noteId as string)
          return next
        })
      } else if (data.type === 'folder' && data.folderId && data.folderId !== destFolderId) {
        await foldersStore.moveFolder(data.folderId, destFolderId)
        foldersStore.loadContents(folderId)
      }
    } catch {
      showToast('Could not move item there.')
    }
  }

  const inDeepMode = deepResults !== null
  // Deep-search results are shown as-is (they may match on tags/dates/category, not
  // just a literal substring, so re-filtering them locally would hide valid matches).
  // Otherwise, the current folder's notes are filtered instantly as the user types.
  const localNotes = useMemo(() => filterLocally(notes, searchQuery), [notes, searchQuery])
  const displayNotes = deepResults ?? localNotes

  // The "Pinned" section only exists at the root, and only outside deep-search mode
  // (results there span folders, so pinning grouping doesn't apply). Inside a folder
  // every note in that folder is shown together, with no separate pinned grouping.
  const pinnedNotes = folderId ? [] : localNotes.filter((n) => n.is_pinned)
  const unpinnedNotes = folderId ? localNotes : localNotes.filter((n) => !n.is_pinned)

  const allSelectableIds = displayNotes.map((n) => n.id)
  const allSelected = allSelectableIds.length > 0 && allSelectableIds.every((id) => selectedIds.has(id))
  function toggleSelectAll() {
    setSelectedIds(allSelected ? new Set() : new Set(allSelectableIds))
  }

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
          selected={selectedIds.has(note.id)}
          onToggleSelect={toggleSelect}
          onShareClick={handleShareClick}
          viewMode={viewMode}
        />
      </DraggableNote>
    ))
  }

  const folderBarProps = {
    folders: subfolders,
    onOpen: openFolder,
    onMove: (f: Folder) => setMoveTarget({ id: f.id }),
    onRename: handleRenameFolder,
    onDelete: handleDeleteFolder,
  }

  const newNotePath = folderId ? `/notes/new?folder=${folderId}` : '/notes/new'

  return (
    <div className="flex flex-col h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-3 shrink-0 no-print">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2 shrink-0">
            <span className="text-2xl">🦎</span>
            Gecko Notes
          </h1>
          <form onSubmit={(e) => { e.preventDefault(); void runDeepSearch() }} className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              type="text"
              placeholder="Search notes... (press Enter to search everywhere)"
              className="input pl-9 pr-9 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 dark:placeholder-gray-400"
            />
            {deepLoading && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 animate-spin" />
            )}
          </form>
          <UserAvatar />
        </div>

        {searchQuery ? (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-full w-fit bg-blue-100 dark:bg-blue-900/40">
            <span className="text-sm font-medium text-blue-800 dark:text-blue-200">Search Results</span>
            <button
              onClick={() => setSearchQuery('')}
              title="Clear search"
              className="p-0.5 rounded-full text-blue-500 dark:text-blue-300 hover:text-blue-700 dark:hover:text-blue-100 hover:bg-blue-200 dark:hover:bg-blue-800 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <FolderBreadcrumb breadcrumb={breadcrumb} onNavigate={openFolder} />
        )}

        <div ref={categoryScrollRef} className="flex items-center gap-2 overflow-x-auto pt-[0.2em] pb-1">
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
            className="text-xs px-3 py-1.5 rounded-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 hover:border-gray-400 dark:hover:border-gray-400 shrink-0 flex items-center gap-1 transition-all disabled:opacity-50"
            title={allSelected ? 'Deselect all notes' : 'Select all notes'}
            disabled={allSelectableIds.length === 0}
            onClick={toggleSelectAll}
          >
            {allSelected ? <CheckCircle2 className="w-3 h-3" /> : <Circle className="w-3 h-3" />}
            {allSelected ? 'Deselect All' : 'Select All'}
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

        {selectedIds.size > 0 && (
          <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{selectedIds.size} selected</span>
            <div className="flex items-center gap-2">
              <button
                className="text-xs px-3 py-1.5 rounded-full border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 flex items-center gap-1 transition-all"
                title="Move selected to folder"
                onClick={() => setNoteMoveOpen(true)}
              >
                <FolderInput className="w-3 h-3" />
                Move
              </button>
              <button
                className="text-xs px-3 py-1.5 rounded-full border border-red-200 dark:border-red-800 bg-white dark:bg-gray-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 flex items-center gap-1 transition-all"
                title="Delete selected"
                onClick={() => setNoteDeleteOpen(true)}
              >
                <Trash2 className="w-3 h-3" />
                Delete
              </button>
              <button
                className="p-1.5 rounded-full text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                title="Clear selection"
                onClick={clearSelection}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </header>

      <div className="flex flex-1 min-h-0 flex-col sm:flex-row">
      <div className="relative flex-1 flex flex-col min-w-0 min-h-0">
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <main className="flex-1 overflow-y-auto px-4 py-4">
          {deepLoading || (loading && notes.length === 0 && subfolders.length === 0 && !inDeepMode) ? (
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
          ) : displayNotes.length === 0 && (inDeepMode || subfolders.length === 0) ? (
            inDeepMode ? (
              <div className="text-center py-20">
                <p className="text-5xl mb-4">🔍</p>
                <p className="text-gray-500 dark:text-gray-400 text-lg font-medium mb-1">No matching notes</p>
                <p className="text-gray-400 dark:text-gray-500 text-sm">Try a different search.</p>
              </div>
            ) : (
              <div className="text-center py-20">
                <p className="text-5xl mb-4">📝</p>
                <p className="text-gray-500 dark:text-gray-400 text-lg font-medium mb-1">{folderId ? 'This folder is empty' : 'No notes yet'}</p>
                <p className="text-gray-400 dark:text-gray-500 text-sm mb-6">Create a note or folder to get started</p>
                <Link to={newNotePath} className="btn-primary inline-flex">
                  <Plus className="w-4 h-4" /> New Note
                </Link>
              </div>
            )
          ) : (
            <>
              {inDeepMode ? (
                <div className={gridClass}>
                  {renderNotes(displayNotes)}
                </div>
              ) : folderId !== null ? (
                <>
                  <FolderIconBar {...folderBarProps} />
                  <div className={gridClass}>
                    {renderNotes(unpinnedNotes)}
                  </div>
                </>
              ) : (
                <>
                  {pinnedNotes.length > 0 && (
                    <>
                      <button
                        className="flex items-center gap-1 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider px-1 mb-2 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                        onClick={togglePinnedCollapsed}
                      >
                        <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${pinnedCollapsed ? '-rotate-90' : ''}`} />
                        Pinned
                      </button>
                      {!pinnedCollapsed && (
                        <div className={`${gridClass} mb-4`}>
                          {renderNotes(pinnedNotes)}
                        </div>
                      )}
                    </>
                  )}
                  <FolderIconBar {...folderBarProps} />
                  {unpinnedNotes.length > 0 && (
                    <>
                      <button
                        className="flex items-center gap-1 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider px-1 mb-2 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                        onClick={toggleNotesCollapsed}
                      >
                        <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${notesCollapsed ? '-rotate-90' : ''}`} />
                        Notes
                      </button>
                      {!notesCollapsed && (
                        <div className={gridClass}>
                          {renderNotes(unpinnedNotes)}
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
              {!inDeepMode && (
                <>
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
            </>
          )}
        </main>
        <DragOverlay dropAnimation={null}>
          {activeDrag?.type === 'folder' && (
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border bg-white dark:bg-gray-800 border-blue-400 shadow-xl cursor-grabbing">
              <FolderIcon className="w-4 h-4 text-blue-500 shrink-0" fill="currentColor" fillOpacity={0.15} />
              <span className="text-xs font-medium text-gray-700 dark:text-gray-200">{activeDrag.label}</span>
            </div>
          )}
          {activeDrag?.type === 'note' && (
            <div className="card dark:bg-gray-800 dark:border-gray-700 px-4 py-3 shadow-xl cursor-grabbing max-w-xs opacity-90">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{activeDrag.label}</p>
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {toast && (
        <div className="fixed bottom-32 left-1/2 -translate-x-1/2 z-50 bg-gray-900 text-white text-sm px-4 py-2 rounded-lg shadow-lg">
          {toast}
        </div>
      )}

      {moveTarget && (
        <FolderPickerModal
          title="Move folder to"
          disabledIds={new Set([moveTarget.id])}
          onSelect={handleMoveSelect}
          onClose={() => setMoveTarget(null)}
        />
      )}

      {noteMoveOpen && (
        <FolderPickerModal
          title={`Move ${selectedIds.size} note${selectedIds.size === 1 ? '' : 's'} to`}
          onSelect={handleBulkMoveSelect}
          onClose={() => setNoteMoveOpen(false)}
        />
      )}

      {noteDeleteOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setNoteDeleteOpen(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-sm w-full mx-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">Delete Notes</h3>
            <p className="text-gray-600 dark:text-gray-400 text-sm mb-6">Are you sure you want to delete {selectedIds.size} note{selectedIds.size === 1 ? '' : 's'}? This cannot be undone.</p>
            <div className="flex gap-3">
              <button className="btn-danger flex-1" onClick={handleBulkDelete}>Delete</button>
              <button className="btn-secondary flex-1" onClick={() => setNoteDeleteOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Close the "+" menu when clicking anywhere outside it */}
      {fabMenuOpen && (
        <div className="fixed inset-0 z-30" onClick={() => setFabMenuOpen(false)} />
      )}

      {/* Add menu: anchored to the notes column (not the viewport) so it never
          overlaps the AI Assistant panel. Offers New Note / New Folder / Import Markdown. */}
      <div className="absolute bottom-6 right-6 z-40 no-print">
        <input
          ref={importInputRef}
          type="file"
          accept=".md,.markdown"
          multiple
          className="hidden"
          onChange={(e) => void handleImportMarkdown(e.target.files)}
        />
        {fabMenuOpen && (
          <div className="absolute bottom-full right-0 mb-3 w-48 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg overflow-hidden p-1">
            <Link
              to={newNotePath}
              onClick={() => setFabMenuOpen(false)}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              <Plus className="w-4 h-4 text-gray-500 dark:text-gray-400" />
              New Note
            </Link>
            <button
              onClick={() => { setFabMenuOpen(false); void handleNewFolder() }}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-left"
            >
              <FolderPlus className="w-4 h-4 text-gray-500 dark:text-gray-400" />
              New Folder
            </button>
            <button
              onClick={() => { setFabMenuOpen(false); importInputRef.current?.click() }}
              disabled={importing}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-left disabled:opacity-50"
            >
              <Upload className="w-4 h-4 text-gray-500 dark:text-gray-400" />
              {importing ? 'Importing…' : 'Import Markdown'}
            </button>
          </div>
        )}
        <button
          onClick={() => setFabMenuOpen((o) => !o)}
          aria-label="Add"
          aria-expanded={fabMenuOpen}
          className="w-12 h-12 bg-blue-600 hover:bg-blue-700 text-white rounded-full shadow-lg flex items-center justify-center transition-all"
        >
          <Plus className={`w-6 h-6 transition-transform ${fabMenuOpen ? 'rotate-45' : ''}`} />
        </button>
      </div>
      </div>

      {/* List-view AI Assistant: scope is the multiselected notes; with none selected
          it searches the library. Global session (null noteId). */}
      <AIConversationPanel
        isOpen={panelOpen}
        onToggle={() => setPanelOpen((o) => !o)}
        mode="list"
        getSelectedNoteIds={() => Array.from(selectedIds)}
        onSearchResults={(label, results) => {
          setSearchQuery(label)
          setDeepResults(results)
        }}
        getNoteContext={() => ''}
        noteId={null}
        onAddToNote={async () => {}}
        editor={aiEditor}
        defaultCategoryId={defaultCategoryId}
        currentFolderId={folderId}
        onNotesChanged={() => { void loadNotes(buildParams(), true) }}
      />
      </div>
    </div>
  )
}
