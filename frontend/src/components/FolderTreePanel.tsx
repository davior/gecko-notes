import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Home, ChevronDown, MoreVertical, FolderPlus, Plus, Upload, FolderInput, Palette, Trash2,
  PanelLeftClose, Folder as FolderIcon,
  type LucideIcon,
} from 'lucide-react'
import type { Folder } from '@/api/folders'
import { resolveFolderIcon } from '@/utils/folderIcons'
import { buildForest, indexById, findArchiveFolder, ancestorIds, type FolderNode } from '@/utils/folderTree'

interface Props {
  folders: Folder[]
  currentFolderId: string | null
  onOpenFolder: (id: string | null) => void
  onNewSubfolder: (parentId: string | null) => void
  onNewNote: (folderId: string | null) => void
  onImport: (folderId: string | null) => void
  onMove: (folder: Folder) => void
  onCustomize: (folder: Folder) => void
  onDelete: (folder: Folder) => void       // parent decides archive vs. permanent delete
  onEmptyArchive: () => void
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

type MenuKind = 'root' | 'normal' | 'archived' | 'bin'
interface MenuTarget { kind: MenuKind; folder: Folder | null }
interface MenuState { target: MenuTarget; top: number; left: number }

const MENU_WIDTH = 192 // matches w-48

interface RowCtx {
  currentFolderId: string | null
  archiveId: string | null
  expanded: Set<string>
  toggleExpand: (id: string) => void
  openMenu: (target: MenuTarget, btn: HTMLElement) => void
  onOpenFolder: (id: string | null) => void
}

const ROW_BASE = 'group flex items-center gap-1 pr-1 rounded-md cursor-pointer select-none'
function rowClasses(active: boolean): string {
  return `${ROW_BASE} ${
    active
      ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
      : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/60'
  }`
}
const ACTION_BTN =
  'p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600 shrink-0 transition-opacity opacity-60 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100'

function TreeRow({ node, depth, inArchive, ctx }: { node: FolderNode; depth: number; inArchive: boolean; ctx: RowCtx }) {
  const { folder } = node
  const isBin = folder.id === ctx.archiveId
  const hasChildren = node.children.length > 0
  const isOpen = ctx.expanded.has(folder.id)
  const isActive = ctx.currentFolderId === folder.id
  const resolved = resolveFolderIcon(folder)
  const btnRef = useRef<HTMLButtonElement>(null)
  const kind: MenuKind = isBin ? 'bin' : inArchive ? 'archived' : 'normal'

  return (
    <>
      <div
        className={rowClasses(isActive)}
        style={{ paddingLeft: `${0.25 + depth * 0.85}rem` }}
        onClick={() => ctx.onOpenFolder(folder.id)}
      >
        {hasChildren ? (
          <button
            className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-600 shrink-0 text-gray-400"
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
          onClick={(e) => { e.stopPropagation(); if (btnRef.current) ctx.openMenu({ kind, folder }, btnRef.current) }}
        >
          <MoreVertical className="w-3.5 h-3.5" />
        </button>
      </div>
      {hasChildren && isOpen && node.children.map((c) => (
        <TreeRow key={c.folder.id} node={c} depth={depth + 1} inArchive={inArchive || isBin} ctx={ctx} />
      ))}
    </>
  )
}

export default function FolderTreePanel({
  folders,
  currentFolderId,
  onOpenFolder,
  onNewSubfolder,
  onNewNote,
  onImport,
  onMove,
  onCustomize,
  onDelete,
  onEmptyArchive,
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
  const menuRef = useRef<HTMLDivElement>(null)

  const isMobileRef = useRef(isMobile)
  const panelWidthRef = useRef(panelWidth)
  const panelHeightRef = useRef(panelHeight)
  useEffect(() => { isMobileRef.current = isMobile }, [isMobile])
  useEffect(() => { panelWidthRef.current = panelWidth }, [panelWidth])
  useEffect(() => { panelHeightRef.current = panelHeight }, [panelHeight])

  const byId = useMemo(() => indexById(folders), [folders])
  const forest = useMemo(() => buildForest(folders), [folders])
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

  // Close the action menu on any outside click.
  useEffect(() => {
    if (!menu) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menu])

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function openMenu(target: MenuTarget, btn: HTMLElement) {
    const rect = btn.getBoundingClientRect()
    // Anchor by the button's left edge (the panel hugs the screen's left), clamped
    // so the menu never spills off the right side.
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8))
    setMenu({ target, top: rect.bottom + 4, left })
  }

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

  const ctx: RowCtx = { currentFolderId, archiveId, expanded, toggleExpand, openMenu, onOpenFolder }
  const rootBtnRef = useRef<HTMLButtonElement>(null)

  function menuItem(key: string, Icon: LucideIcon, label: string, onClick: () => void, danger = false) {
    return (
      <button
        key={key}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-700 ${
          danger ? 'text-red-600 dark:text-red-400' : 'text-gray-700 dark:text-gray-200'
        }`}
        onClick={() => { setMenu(null); onClick() }}
      >
        <Icon className="w-4 h-4 shrink-0" /> <span className="truncate">{label}</span>
      </button>
    )
  }

  function renderMenuItems(target: MenuTarget) {
    const { kind, folder } = target
    const fid = folder?.id ?? null
    if (kind === 'bin') {
      return [menuItem('empty', Trash2, 'Empty Archive Bin', onEmptyArchive, true)]
    }
    if (kind === 'archived' && folder) {
      return [
        menuItem('restore', FolderInput, 'Move out / restore…', () => onMove(folder)),
        menuItem('delete', Trash2, 'Delete permanently', () => onDelete(folder), true),
      ]
    }
    if (kind === 'root') {
      return [
        menuItem('new-folder', FolderPlus, 'New folder', () => onNewSubfolder(null)),
        menuItem('new-note', Plus, 'New note', () => onNewNote(null)),
        menuItem('import', Upload, 'Import Markdown', () => onImport(null)),
      ]
    }
    // normal folder
    if (!folder) return null
    return [
      menuItem('new-sub', FolderPlus, 'New subfolder', () => onNewSubfolder(fid)),
      menuItem('new-note', Plus, 'New note', () => onNewNote(fid)),
      menuItem('import', Upload, 'Import Markdown', () => onImport(fid)),
      <div key="sep" className="my-1 border-t border-gray-100 dark:border-gray-700" />,
      menuItem('move', FolderInput, 'Move to…', () => onMove(folder)),
      menuItem('customize', Palette, 'Customize', () => onCustomize(folder)),
      menuItem('delete', Trash2, 'Delete', () => onDelete(folder), true),
    ]
  }

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

        <nav className="flex-1 min-h-0 overflow-y-auto py-1 px-1">
          {/* Root "All notes" */}
          <div
            className={rowClasses(rootActive)}
            style={{ paddingLeft: '0.25rem' }}
            onClick={() => onOpenFolder(null)}
          >
            <span className="w-[1.375rem] shrink-0" />
            <Home className="w-4 h-4 shrink-0 text-gray-400" />
            <span className="truncate flex-1 text-sm py-1 font-medium">All notes</span>
            <button
              ref={rootBtnRef}
              className={ACTION_BTN}
              title="Add here"
              onClick={(e) => { e.stopPropagation(); if (rootBtnRef.current) openMenu({ kind: 'root', folder: null }, rootBtnRef.current) }}
            >
              <MoreVertical className="w-3.5 h-3.5" />
            </button>
          </div>

          {normalRoots.map((n) => (
            <TreeRow key={n.folder.id} node={n} depth={1} inArchive={false} ctx={ctx} />
          ))}

          {normalRoots.length === 0 && !archiveNode && (
            <p className="px-3 py-2 text-xs text-gray-400 dark:text-gray-500">
              No folders yet. Use the ⋯ menu to add one.
            </p>
          )}

          {archiveNode && (
            <>
              <div className="my-1 border-t border-gray-100 dark:border-gray-700/70" />
              <TreeRow node={archiveNode} depth={1} inArchive={false} ctx={ctx} />
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

      {menu && createPortal(
        <div
          ref={menuRef}
          className="fixed z-50 w-48 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 text-sm"
          style={{ top: menu.top, left: menu.left }}
          onClick={(e) => e.stopPropagation()}
        >
          {renderMenuItems(menu.target)}
        </div>,
        document.body,
      )}
    </aside>
  )
}
