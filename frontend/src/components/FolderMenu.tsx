import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  FolderPlus, Plus, Upload, Globe, Search, FolderInput, Palette, Trash2, type LucideIcon,
} from 'lucide-react'
import type { Folder } from '@/api/folders'
import type { FolderMenuTarget } from '@/utils/folderTree'

/** Everything a folder menu can do. The folder tree, the folder bar and the notes
 *  background all show this one menu, so they share one set of handlers. */
export interface FolderMenuActions {
  onNewSubfolder: (parentId: string | null) => void
  onNewDynamicFolder: (parentId: string | null) => void
  onNewNote: (folderId: string | null) => void
  onImport: (folderId: string | null) => void
  onImportUrl: (folderId: string | null) => void
  onMove: (folder: Folder) => void
  onCustomize: (folder: Folder) => void
  onDelete: (folder: Folder) => void       // parent decides archive vs. permanent delete
  onEmptyArchive: () => void
}

interface Props {
  target: FolderMenuTarget
  /** Viewport position of the menu's top-left corner; nudged to stay on screen. */
  x: number
  y: number
  actions: FolderMenuActions
  onClose: () => void
}

const EDGE = 8

export default function FolderMenu({ target, x, y, actions, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // Measure once rendered and pull the menu back inside the viewport (runs before paint,
  // so it never flashes in the wrong place).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      left: Math.max(EDGE, Math.min(x, window.innerWidth - width - EDGE)),
      top: Math.max(EDGE, Math.min(y, window.innerHeight - height - EDGE)),
    })
  }, [x, y, target])

  // Close on any outside press or Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  function item(key: string, Icon: LucideIcon, label: string, onClick: () => void, danger = false) {
    return (
      <button
        key={key}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-700 ${
          danger ? 'text-red-600 dark:text-red-400' : 'text-gray-700 dark:text-gray-200'
        }`}
        onClick={() => { onClose(); onClick() }}
      >
        <Icon className="w-4 h-4 shrink-0" /> <span className="truncate">{label}</span>
      </button>
    )
  }

  function createItems(folderId: string | null) {
    return [
      item('new-sub', FolderPlus, folderId ? 'New subfolder' : 'New folder', () => actions.onNewSubfolder(folderId)),
      item('new-dynamic', Search, 'New dynamic folder', () => actions.onNewDynamicFolder(folderId)),
      item('new-note', Plus, 'New note', () => actions.onNewNote(folderId)),
      item('import', Upload, 'Import Markdown', () => actions.onImport(folderId)),
      item('import-url', Globe, 'Import URL', () => actions.onImportUrl(folderId)),
    ]
  }

  function items() {
    switch (target.kind) {
      case 'bin':
        return [item('empty', Trash2, 'Empty Archive Bin', actions.onEmptyArchive, true)]
      case 'archived': {
        const { folder } = target
        return [
          item('restore', FolderInput, 'Move out / restore…', () => actions.onMove(folder)),
          item('delete', Trash2, 'Delete permanently', () => actions.onDelete(folder), true),
        ]
      }
      // Dynamic (saved-search) folder: a leaf, so no "new child" actions.
      case 'dynamic': {
        const { folder } = target
        return [
          item('move', FolderInput, 'Move to…', () => actions.onMove(folder)),
          item('customize', Palette, 'Customize', () => actions.onCustomize(folder)),
          item('delete', Trash2, 'Delete', () => actions.onDelete(folder), true),
        ]
      }
      case 'create':
        return createItems(target.folderId)
      case 'normal': {
        const { folder } = target
        return [
          ...createItems(folder.id),
          <div key="sep" className="my-1 border-t border-gray-100 dark:border-gray-700" />,
          item('move', FolderInput, 'Move to…', () => actions.onMove(folder)),
          item('customize', Palette, 'Customize', () => actions.onCustomize(folder)),
          item('delete', Trash2, 'Delete', () => actions.onDelete(folder), true),
        ]
      }
    }
  }

  return createPortal(
    <div
      ref={ref}
      className="fixed z-50 w-48 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 text-sm"
      style={{ top: pos.top, left: pos.left }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
    >
      {items()}
    </div>,
    document.body,
  )
}
