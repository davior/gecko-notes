import { ChevronRight, Home } from 'lucide-react'
import type { Folder } from '@/api/folders'
import { resolveFolderIcon } from '@/utils/folderIcons'

interface Props {
  breadcrumb: Folder[]
  onNavigate: (folderId: string | null) => void
  /** Extra classes for the <nav> spacing slot; defaults to `mb-2` for stacked layouts. */
  className?: string
}

/** Breadcrumb trail for the current folder: Home / Parent / … / Current. */
export default function FolderBreadcrumb({ breadcrumb, onNavigate, className }: Props) {
  return (
    <nav className={`flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 overflow-x-auto ${className ?? 'mb-2'}`}>
      <button
        className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-200 shrink-0 transition-colors"
        onClick={() => onNavigate(null)}
      >
        <Home className="w-3.5 h-3.5" />
        All notes
      </button>
      {breadcrumb.map((folder, i) => {
        const isLast = i === breadcrumb.length - 1
        const resolved = resolveFolderIcon(folder)
        return (
          <span key={folder.id} className="flex items-center gap-1 shrink-0">
            <ChevronRight className="w-3.5 h-3.5 text-gray-300 dark:text-gray-600" />
            <button
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors max-w-[12rem] ${
                isLast
                  ? 'font-semibold text-gray-800 dark:text-gray-100'
                  : 'hover:text-gray-700 dark:hover:text-gray-200'
              }`}
              onClick={() => onNavigate(folder.id)}
              disabled={isLast}
            >
              {resolved.kind === 'emoji' ? (
                <span className="text-sm leading-none shrink-0">{resolved.emoji}</span>
              ) : (
                <resolved.Icon
                  className={`w-3.5 h-3.5 shrink-0 ${folder.color ? '' : 'text-gray-400'}`}
                  style={{ color: folder.color ?? undefined }}
                />
              )}
              <span className="truncate">{folder.name}</span>
            </button>
          </span>
        )
      })}
    </nav>
  )
}
