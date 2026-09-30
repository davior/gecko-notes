import { useRef, useEffect } from 'react'
import { MoreVertical } from 'lucide-react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import type { Folder } from '@/api/folders'
import { isDynamicFolder } from '@/utils/folderTree'
import FolderTile from './FolderTile'

interface Props {
  folders: Folder[]
  onOpen: (id: string) => void
  onOpenDynamic: (folder: Folder) => void
  /** Show the folder menu at a viewport position — from the ⋮ button or a right-click. */
  onOpenMenu: (folder: Folder, x: number, y: number) => void
}

interface ChipProps {
  folder: Folder
  onOpen: (id: string) => void
  onOpenDynamic: (folder: Folder) => void
  onOpenMenu: (folder: Folder, x: number, y: number) => void
}

function FolderChip({ folder, onOpen, onOpenDynamic, onOpenMenu }: ChipProps) {
  const btnRef = useRef<HTMLButtonElement>(null)

  const isDynamic = isDynamicFolder(folder)
  // A dynamic folder is a leaf that runs a search — never a drop target for notes/folders.
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `folder-drop:${folder.id}`, data: { folderId: folder.id }, disabled: isDynamic })
  const { setNodeRef: setDragRef, attributes, listeners, isDragging } = useDraggable({
    id: `folder-drag:${folder.id}`,
    data: { type: 'folder', folderId: folder.id },
  })

  const setRefs = (el: HTMLDivElement | null) => { setDropRef(el); setDragRef(el) }

  return (
    <div
      ref={setRefs}
      {...attributes}
      {...listeners}
      className={`relative group flex flex-col items-center p-1.5 rounded-lg border shrink-0 cursor-pointer bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 hover:border-gray-300 dark:hover:border-gray-600 transition-all ${isOver ? 'ring-2 ring-blue-500 ring-offset-1' : ''} ${isDragging ? 'opacity-30' : ''}`}
      onClick={() => (isDynamic ? onOpenDynamic(folder) : onOpen(folder.id))}
      // Stop here so the notes background's own right-click menu doesn't also open.
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onOpenMenu(folder, e.clientX, e.clientY) }}
      title={isDynamic ? folder.search_query ?? undefined : undefined}
    >
      <FolderTile folder={folder} size={32} />
      <button
        ref={btnRef}
        className="absolute top-0.5 right-0.5 p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 shrink-0 transition-opacity opacity-0 group-hover:opacity-100 focus:opacity-100"
        title="Folder actions"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          if (!btnRef.current) return
          const rect = btnRef.current.getBoundingClientRect()
          onOpenMenu(folder, rect.left, rect.bottom + 4)
        }}
      >
        <MoreVertical className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

export default function FolderIconBar({ folders, onOpen, onOpenDynamic, onOpenMenu }: Props) {
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
          onOpenMenu={onOpenMenu}
        />
      ))}
    </div>
  )
}
