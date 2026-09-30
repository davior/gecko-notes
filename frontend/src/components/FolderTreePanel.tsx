import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import {
  Home, ChevronDown, MoreVertical, FolderPlus, PanelLeftClose, Folder as FolderIcon,
} from 'lucide-react'
import type { Folder } from '@/api/folders'
import { resolveFolderIcon } from '@/utils/folderIcons'
import {
  buildForest, indexById, findArchiveFolder, ancestorIds, isDynamicFolder,
  folderFilterIds, pruneForest, folderMenuTarget,
  type FolderNode, type FolderMenuTarget,
} from '@/utils/folderTree'
import FolderMenu, { type FolderMenuActions } from './FolderMenu'
import FolderFilterInput from './FolderFilterInput'

interface Props extends FolderMenuActions {
  folders: Folder[]
  currentFolderId: string | null
  onOpenFolder: (id: string | null) => void
  onOpenDynamic: (folder: Folder) => void  // clicking a dynamic folder runs its saved search
  /** Folder currently being dragged (from here or the folder bar), so rows that can't
   *  accept it — itself, its descendants, its current parent — stop offering to. The
   *  drag/drop context itself lives in the parent; this panel only registers rows. */
  draggingFolderId?: string | null
  storageKey?: string
}

const DEFAULT_WIDTH = 260
const MIN_WIDTH = 200
const MAX_WIDTH = 520
const DEFAULT_HEIGHT = 240
const MIN_HEIGHT = 150
const MAX_HEIGHT = 500

function readStoredSize(key: string, fallback: number): number {
  try {
    const v = parseInt(localStorage.getItem(key) ?? '', 10)
    return Number.isFinite(v) ? v : fallback
  } catch {
    return fallback
  }
}

interface MenuState { target: FolderMenuTarget; x: number; y: number }

// Hovering a collapsed folder this long mid-drag opens it, so nested targets are reachable.
const DRAG_EXPAND_MS = 600

interface RowCtx {
  currentFolderId: string | null
  archiveId: string | null
  byId: Map<string, Folder>
  draggingFolderId: string | null
  expanded: Set<string>
  /** A name filter is active: every branch that survived it is shown open, and the
   *  chevrons stop toggling (the saved expanded set is left alone for when it clears). */
  filtering: boolean
  toggleExpand: (id: string) => void
  expand: (id: string) => void
  openMenu: (target: FolderMenuTarget, x: number, y: number) => void
  onOpenFolder: (id: string | null) => void
  onOpenDynamic: (folder: Folder) => void
}

const ROW_BASE = 'group flex items-center gap-1 pr-1 rounded-md cursor-pointer select-none'
function rowClasses(active: boolean): string {
  return `${ROW_BASE} ${
    active
      ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
      : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/60'
  }`
}
const DROP_HIGHLIGHT = 'ring-2 ring-blue-500 bg-blue-50 dark:bg-blue-900/30'

/** Whether a folder being dragged may be dropped onto `target` (null = the root). */
function canDropFolderOn(
  dragging: string | null,
  target: string | null,
  byId: Map<string, Folder>,
): boolean {
  if (!dragging) return true
  if (target === dragging) return false
  if (byId.get(dragging)?.parent_folder_id === target) return false  // already there
  return target === null || !ancestorIds(target, byId).includes(dragging)
}
const ACTION_BTN =
  'p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600 shrink-0 transition-opacity opacity-60 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100'

function TreeRow({ node, depth, ctx }: { node: FolderNode; depth: number; ctx: RowCtx }) {
  const { folder } = node
  const isBin = folder.id === ctx.archiveId
  const isDynamic = isDynamicFolder(folder)
  const hasChildren = !isDynamic && node.children.length > 0
  const isOpen = ctx.filtering || ctx.expanded.has(folder.id)
  const isActive = ctx.currentFolderId === folder.id
  const resolved = resolveFolderIcon(folder)
  const btnRef = useRef<HTMLButtonElement>(null)

  // Ids are prefixed `tree-` because the folder bar registers the same folders as
  // `folder-drag:`/`folder-drop:` in the one shared DndContext, and ids must be unique.
  // A dynamic folder is a leaf that runs a search, so nothing can be dropped on it.
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `tree-drop:${folder.id}`,
    data: { folderId: folder.id },
    disabled: isDynamic || !canDropFolderOn(ctx.draggingFolderId, folder.id, ctx.byId),
  })
  // The Archive Bin is app-managed: it can receive items but never be moved.
  const { setNodeRef: setDragRef, attributes, listeners, isDragging } = useDraggable({
    id: `tree-drag:${folder.id}`,
    data: { type: 'folder', folderId: folder.id },
    disabled: isBin,
  })

  useEffect(() => {
    if (!isOver || !hasChildren || isOpen) return
    const timer = setTimeout(() => ctx.expand(folder.id), DRAG_EXPAND_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOver, hasChildren, isOpen, folder.id])

  return (
    <>
      <div
        ref={(el) => { setDropRef(el); setDragRef(el) }}
        {...attributes}
        {...listeners}
        className={`${rowClasses(isActive)} ${isOver ? DROP_HIGHLIGHT : ''} ${isDragging ? 'opacity-40' : ''}`}
        style={{ paddingLeft: `${0.25 + depth * 0.85}rem` }}
        onClick={() => (isDynamic ? ctx.onOpenDynamic(folder) : ctx.onOpenFolder(folder.id))}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          ctx.openMenu(folderMenuTarget(folder, ctx.archiveId, ctx.byId), e.clientX, e.clientY)
        }}
        title={isDynamic ? folder.search_query ?? undefined : undefined}
      >
        {hasChildren && ctx.filtering ? (
          <span className="p-1 shrink-0 text-gray-400">
            <ChevronDown className="w-3.5 h-3.5" />
          </span>
        ) : hasChildren ? (
          // p-1 makes this button 1.375rem wide (0.25rem×2 padding + 0.875rem icon),
          // matching the placeholder span below so folder icons line up whether or
          // not a folder has children.
          <button
            className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 shrink-0 text-gray-400"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); ctx.toggleExpand(folder.id) }}
            title={isOpen ? 'Collapse' : 'Expand'}
          >
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isOpen ? '' : '-rotate-90'}`} />
          </button>
        ) : (
          <span className="w-[1.375rem] shrink-0" />
        )}
        {resolved.kind === 'emoji' ? (
          <span className="text-sm leading-none shrink-0">{resolved.emoji}</span>
        ) : (
          <resolved.Icon
            className={`w-4 h-4 shrink-0 ${folder.color ? '' : 'text-blue-500'}`}
            style={{ color: folder.color ?? undefined }}
          />
        )}
        <span className="truncate flex-1 text-sm py-1">{folder.name}</span>
        <button
          ref={btnRef}
          className={ACTION_BTN}
          title="Folder actions"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            if (!btnRef.current) return
            const rect = btnRef.current.getBoundingClientRect()
            ctx.openMenu(folderMenuTarget(folder, ctx.archiveId, ctx.byId), rect.left, rect.bottom + 4)
          }}
        >
          <MoreVertical className="w-3.5 h-3.5" />
        </button>
      </div>
      {hasChildren && isOpen && node.children.map((c) => (
        <TreeRow key={c.folder.id} node={c} depth={depth + 1} ctx={ctx} />
      ))}
    </>
  )
}

export default function FolderTreePanel({
  folders,
  currentFolderId,
  onOpenFolder,
  onOpenDynamic,
  onNewSubfolder,
  onNewDynamicFolder,
  onNewNote,
  onImport,
  onImportUrl,
  onMove,
  onCustomize,
  onDelete,
  onEmptyArchive,
  draggingFolderId = null,
  storageKey = 'folder-tree-panel',
}: Props) {
  const openKey = `${storageKey}-open`
  const widthKey = `${storageKey}-width`
  const heightKey = `${storageKey}-height`
  const expandedKey = `${storageKey}-expanded`

  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(openKey) !== 'false' } catch { return true }
  })
  const [isMobile, setIsMobile] = useState(() => (typeof window !== 'undefined' ? window.innerWidth < 640 : false))
  const [panelWidth, setPanelWidth] = useState<number>(() => readStoredSize(widthKey, DEFAULT_WIDTH))
  const [panelHeight, setPanelHeight] = useState<number>(() => readStoredSize(heightKey, DEFAULT_HEIGHT))
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(expandedKey)
      if (raw) return new Set(JSON.parse(raw) as string[])
    } catch { /* noop */ }
    return new Set()
  })
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [filter, setFilter] = useState('')

  const isMobileRef = useRef(isMobile)
  const panelWidthRef = useRef(panelWidth)
  const panelHeightRef = useRef(panelHeight)
  useEffect(() => { isMobileRef.current = isMobile }, [isMobile])
  useEffect(() => { panelWidthRef.current = panelWidth }, [panelWidth])
  useEffect(() => { panelHeightRef.current = panelHeight }, [panelHeight])

  const byId = useMemo(() => indexById(folders), [folders])
  const fullForest = useMemo(() => buildForest(folders), [folders])
  // While filtering, only matching folders and their ancestors survive; "All notes" (the
  // root row) is rendered outside the forest, so it always stays.
  const filterIds = useMemo(() => folderFilterIds(folders, filter), [folders, filter])
  const forest = useMemo(
    () => (filterIds ? pruneForest(fullForest, filterIds) : fullForest),
    [fullForest, filterIds],
  )
  const filtering = filterIds !== null
  const archiveFolder = useMemo(() => findArchiveFolder(folders), [folders])
  const archiveId = archiveFolder?.id ?? null
  const normalRoots = useMemo(() => forest.filter((n) => n.folder.id !== archiveId), [forest, archiveId])
  const archiveNode = useMemo(() => forest.find((n) => n.folder.id === archiveId) ?? null, [forest, archiveId])

  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 640)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  useEffect(() => { try { localStorage.setItem(openKey, String(open)) } catch { /* noop */ } }, [open, openKey])
  useEffect(() => { try { localStorage.setItem(widthKey, String(panelWidth)) } catch { /* noop */ } }, [panelWidth, widthKey])
  useEffect(() => { try { localStorage.setItem(heightKey, String(panelHeight)) } catch { /* noop */ } }, [panelHeight, heightKey])
  useEffect(() => {
    try { localStorage.setItem(expandedKey, JSON.stringify([...expanded])) } catch { /* noop */ }
  }, [expanded, expandedKey])

  // Auto-expand ancestors of the current folder so it's always visible in the tree.
  useEffect(() => {
    if (!currentFolderId) return
    const anc = ancestorIds(currentFolderId, byId)
    if (anc.length === 0) return
    setExpanded((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const id of anc) if (!next.has(id)) { next.add(id); changed = true }
      return changed ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFolderId, folders])

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function expand(id: string) {
    setExpanded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
  }

  function openMenu(target: FolderMenuTarget, x: number, y: number) {
    setMenu({ target, x, y })
  }
  const closeMenu = useCallback(() => setMenu(null), [])

  function startResize(e: React.MouseEvent) {
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const startWidth = panelWidthRef.current
    const startHeight = panelHeightRef.current
    function onMouseMove(ev: MouseEvent) {
      if (isMobileRef.current) {
        const delta = ev.clientY - startY
        setPanelHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHeight + delta)))
      } else {
        const delta = ev.clientX - startX
        setPanelWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + delta)))
      }
    }
    function onMouseUp() {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = isMobileRef.current ? 'ns-resize' : 'ew-resize'
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  const ctx: RowCtx = {
    currentFolderId, archiveId, byId, draggingFolderId, expanded, filtering, toggleExpand, expand, openMenu, onOpenFolder, onOpenDynamic,
  }
  const rootBtnRef = useRef<HTMLButtonElement>(null)
  // "All notes" is the root: dropping here moves a note or folder out to the top level.
  const { setNodeRef: setRootDropRef, isOver: rootIsOver } = useDroppable({
    id: 'tree-drop:root',
    data: { folderId: null },
    disabled: !canDropFolderOn(draggingFolderId, null, byId),
  })

  if (!open) {
    return (
      <div className="shrink-0 flex sm:flex-col items-center justify-center no-print">
        <button
          onClick={() => setOpen(true)}
          className="sm:h-full w-full sm:w-9 flex sm:flex-col items-center justify-center gap-2 px-3 sm:px-0 py-2 sm:py-0 border-b sm:border-b-0 sm:border-r border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 hover:bg-blue-50 dark:hover:bg-blue-900/20 hover:text-blue-500 text-gray-400 transition-colors"
          title="Show folders"
        >
          <FolderIcon className="w-4 h-4" />
          <span className="text-xs sm:hidden">Folders</span>
          <span className="hidden sm:block text-xs font-medium tracking-widest" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
            Folders
          </span>
        </button>
      </div>
    )
  }

  const containerStyle = isMobile ? { height: panelHeight } : { width: panelWidth }
  const rootActive = currentFolderId === null

  return (
    <aside
      className="flex flex-col sm:flex-row shrink-0 border-b sm:border-b-0 sm:border-r border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-900 no-print"
      style={containerStyle}
    >
      <div className="flex flex-col flex-1 min-h-0 min-w-0">
        <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-gray-700">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-gray-800 dark:text-gray-100">
            <FolderIcon className="w-4 h-4 text-blue-500" />
            Folders
          </div>
          <div className="flex items-center gap-0.5">
            <button className="btn-ghost p-1" title="New folder" onClick={() => onNewSubfolder(null)}>
              <FolderPlus className="w-4 h-4" />
            </button>
            <button className="btn-ghost p-1" title="Hide folders" onClick={() => setOpen(false)}>
              <PanelLeftClose className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="shrink-0 px-2 py-1.5 border-b border-gray-100 dark:border-gray-700">
          <FolderFilterInput value={filter} onChange={setFilter} />
        </div>

        <nav className="flex-1 min-h-0 overflow-y-auto py-1 px-1">
          {/* Root "All notes" */}
          <div
            ref={setRootDropRef}
            className={`${rowClasses(rootActive)} ${rootIsOver ? DROP_HIGHLIGHT : ''}`}
            style={{ paddingLeft: '0.25rem' }}
            onClick={() => onOpenFolder(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              openMenu({ kind: 'create', folderId: null }, e.clientX, e.clientY)
            }}
          >
            <span className="w-[1.375rem] shrink-0" />
            <Home className="w-4 h-4 shrink-0 text-gray-400" />
            <span className="truncate flex-1 text-sm py-1 font-medium">All notes</span>
            <button
              ref={rootBtnRef}
              className={ACTION_BTN}
              title="Add here"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                if (!rootBtnRef.current) return
                const rect = rootBtnRef.current.getBoundingClientRect()
                openMenu({ kind: 'create', folderId: null }, rect.left, rect.bottom + 4)
              }}
            >
              <MoreVertical className="w-3.5 h-3.5" />
            </button>
          </div>

          {normalRoots.map((n) => (
            <TreeRow key={n.folder.id} node={n} depth={1} ctx={ctx} />
          ))}

          {normalRoots.length === 0 && !archiveNode && (
            <p className="px-3 py-2 text-xs text-gray-400 dark:text-gray-500">
              {filtering ? <>No folders match “{filter.trim()}”.</> : 'No folders yet. Use the ⋯ menu to add one.'}
            </p>
          )}

          {archiveNode && (
            <>
              <div className="my-1 border-t border-gray-100 dark:border-gray-700/70" />
              <TreeRow node={archiveNode} depth={1} ctx={ctx} />
            </>
          )}
        </nav>
      </div>

      {/* Resize gutter — drag the bottom edge (mobile) or right edge (desktop). */}
      <div
        className={`shrink-0 transition-colors hover:bg-blue-400/40 active:bg-blue-400/60 ${
          isMobile ? 'h-1.5 w-full cursor-ns-resize' : 'w-1.5 cursor-ew-resize'
        }`}
        onMouseDown={startResize}
        title="Drag to resize"
      />

      {menu && (
        <FolderMenu
          target={menu.target}
          x={menu.x}
          y={menu.y}
          actions={{
            onNewSubfolder, onNewDynamicFolder, onNewNote, onImport, onImportUrl,
            onMove, onCustomize, onDelete, onEmptyArchive,
          }}
          onClose={closeMenu}
        />
      )}
    </aside>
  )
}
