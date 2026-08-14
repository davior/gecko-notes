import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { MoreVertical, FolderInput, Palette, Trash2 } from 'lucide-react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import type { Folder } from '@/api/folders'
import { isDynamicFolder } from '@/utils/folderTree'
import FolderTile from './FolderTile'

interface Props {
  folders: Folder[]
  onOpen: (id: string) => void
  onOpenDynamic: (folder: Folder) => void
  onMove: (folder: Folder) => void
  onCustomize: (folder: Folder) => void
  onDelete: (folder: Folder) => void
}

interface ChipProps {
  folder: Folder
  onOpen: (id: string) => void
  onOpenDynamic: (folder: Folder) => void
  onMove: (folder: Folder) => void
  onCustomize: (folder: Folder) => void
  onDelete: (folder: Folder) => void
}

function FolderChip({ folder, onOpen, onOpenDynamic, onMove, onCustomize, onDelete }: ChipProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  const isDynamic = isDynamicFolder(folder)
  // A dynamic folder is a leaf that runs a search — never a drop target for notes/folders.
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `folder-drop:${folder.id}`, disabled: isDynamic })
  const { setNodeRef: setDragRef, attributes, listeners, isDragging } = useDraggable({
    id: `folder-drag:${folder.id}`,
    data: { type: 'folder', folderId: folder.id },
  })

  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  const setRefs = (el: HTMLDivElement | null) => { setDropRef(el); setDragRef(el) }

  function openMenu(e: React.MouseEvent) {
    e.stopPropagation()
    if (!menuOpen && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
    }
    setMenuOpen((o) => !o)
  }

  return (
    <div
      ref={setRefs}
      {...attributes}
      {...listeners}
      className={`relative group flex flex-col items-center p-1.5 rounded-lg border shrink-0 cursor-pointer bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 hover:border-gray-300 dark:hover:border-gray-600 transition-all ${isOver ? 'ring-2 ring-blue-500 ring-offset-1' : ''} ${isDragging ? 'opacity-30' : ''}`}
      onClick={() => (isDynamic ? onOpenDynamic(folder) : onOpen(folder.id))}
      title={isDynamic ? folder.search_query ?? undefined : undefined}
    >
      <FolderTile folder={folder} size={32} />
      <button
        ref={btnRef}
        className={`absolute top-0.5 right-0.5 p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 shrink-0 transition-opacity ${menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
        title="Folder actions"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={openMenu}
      >
        <MoreVertical className="w-3.5 h-3.5" />
      </button>
      {menuOpen && menuPos && createPortal(
        <div
          ref={menuRef}
          className="fixed z-50 w-40 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 text-sm"
          style={{ top: menuPos.top, right: menuPos.right }}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
            onClick={() => { setMenuOpen(false); onMove(folder) }}
          >
            <FolderInput className="w-4 h-4" /> Move to…
          </button>
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
            onClick={() => { setMenuOpen(false); onCustomize(folder) }}
          >
            <Palette className="w-4 h-4" /> Customize
          </button>
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700"
            onClick={() => { setMenuOpen(false); onDelete(folder) }}
          >
            <Trash2 className="w-4 h-4" /> Delete
          </button>
        </div>,
        document.body
      )}
    </div>
  )
}

export default function FolderIconBar({ folders, onOpen, onOpenDynamic, onMove, onCustomize, onDelete }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      if (e.deltaY === 0) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  if (folders.length === 0) return null

  return (
    <div
      ref={scrollRef}
      className="flex items-start gap-2 overflow-x-auto pb-2 mb-3"
      style={{ scrollbarWidth: 'thin' }}
    >
      {folders.map((folder) => (
        <FolderChip
          key={folder.id}
          folder={folder}
          onOpen={onOpen}
          onOpenDynamic={onOpenDynamic}
          onMove={onMove}
          onCustomize={onCustomize}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}
