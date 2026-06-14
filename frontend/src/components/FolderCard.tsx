import { useState, useRef, useEffect } from 'react'
import { Folder as FolderIcon, MoreVertical, FolderInput, Pencil, Trash2 } from 'lucide-react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import type { Folder } from '@/api/folders'

interface Props {
  folder: Folder
  viewMode?: 'list' | 'card'
  onOpen: (id: string) => void
  onMove: (folder: Folder) => void
  onRename: (folder: Folder) => void
  onDelete: (folder: Folder) => void
}

export default function FolderCard({ folder, viewMode = 'list', onOpen, onMove, onRename, onDelete }: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Droppable: notes / other folders can be dropped onto this folder.
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `folder-drop:${folder.id}` })
  // Draggable: this folder can be moved into another folder.
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

  const ring = isOver ? 'ring-2 ring-blue-500 ring-offset-1' : ''
  const dragging = isDragging ? 'opacity-50' : ''

  const menu = (
    <div className="relative shrink-0" ref={menuRef}>
      <button
        className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
        title="Folder actions"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o) }}
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {menuOpen && (
        <div
          className="absolute right-0 top-full mt-1 z-20 w-40 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 text-sm"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button className="w-full flex items-center gap-2 px-3 py-1.5 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700" onClick={() => { setMenuOpen(false); onMove(folder) }}>
            <FolderInput className="w-4 h-4" /> Move to…
          </button>
          <button className="w-full flex items-center gap-2 px-3 py-1.5 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700" onClick={() => { setMenuOpen(false); onRename(folder) }}>
            <Pencil className="w-4 h-4" /> Rename
          </button>
          <button className="w-full flex items-center gap-2 px-3 py-1.5 text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700" onClick={() => { setMenuOpen(false); onDelete(folder) }}>
            <Trash2 className="w-4 h-4" /> Delete
          </button>
        </div>
      )}
    </div>
  )

  if (viewMode === 'card') {
    return (
      <div
        ref={setRefs}
        {...attributes}
        {...listeners}
        className={`card cursor-pointer h-52 flex flex-col justify-between p-3 transition-all duration-200 hover:shadow-xl hover:-translate-y-1 dark:bg-gray-800 dark:border-gray-700 ${ring} ${dragging}`}
        onClick={() => onOpen(folder.id)}
      >
        <div className="flex items-start justify-between">
          <FolderIcon className="w-10 h-10 text-blue-500" fill="currentColor" fillOpacity={0.15} />
          {menu}
        </div>
        <h3 className="font-semibold text-sm text-gray-900 dark:text-gray-100 truncate">{folder.name}</h3>
      </div>
    )
  }

  // List view
  return (
    <div
      ref={setRefs}
      {...attributes}
      {...listeners}
      className={`card cursor-pointer flex items-center gap-3 p-4 dark:bg-gray-800 dark:border-gray-700 transition-all ${ring} ${dragging}`}
      onClick={() => onOpen(folder.id)}
    >
      <FolderIcon className="w-6 h-6 text-blue-500 shrink-0" fill="currentColor" fillOpacity={0.15} />
      <h3 className="flex-1 font-semibold text-sm text-gray-900 dark:text-gray-100 truncate">{folder.name}</h3>
      {menu}
    </div>
  )
}
