import { Pin } from 'lucide-react'
import type { NoteListItem } from '@/api/notes'
import type { Category } from '@/api/categories'
import CategoryBadge from './CategoryBadge'
import TagChip from './TagChip'

function relativeDate(dateStr: string): string {
  const date = new Date(dateStr)
  const diffMs = Date.now() - date.getTime()
  const diffSecs = Math.floor(diffMs / 1000)
  const diffMins = Math.floor(diffSecs / 60)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)
  if (diffSecs < 60) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays} days ago`
  return date.toLocaleDateString()
}

interface Props {
  note: NoteListItem
  category?: Category
  onClick: (id: string) => void
  onPin?: (id: string) => void
}

export default function NoteCard({ note, category, onClick, onPin }: Props) {
  const visibleTags = note.tags.slice(0, 4)

  return (
    <div
      className="card cursor-pointer hover:shadow-md transition-shadow duration-150 flex overflow-hidden dark:bg-gray-800 dark:border-gray-700"
      onClick={() => onClick(note.id)}
    >
      <div className="w-1 shrink-0 rounded-l-xl" style={{ backgroundColor: category?.color ?? '#6B7280' }} />
      <div className="flex-1 p-4 min-w-0">
        <div className="flex items-center justify-between mb-2 gap-2">
          {category ? <CategoryBadge category={category} /> : <span className="text-xs text-gray-400">Uncategorised</span>}
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-gray-400">{relativeDate(note.modified_at)}</span>
            {onPin && (
              <button
                className={`p-0.5 rounded transition-colors ${note.is_pinned ? 'text-blue-500' : 'text-gray-300 hover:text-gray-500'}`}
                title={note.is_pinned ? 'Unpin note' : 'Pin to top'}
                onClick={(e) => { e.stopPropagation(); onPin(note.id) }}
              >
                <Pin className="w-3.5 h-3.5" fill={note.is_pinned ? 'currentColor' : 'none'} />
              </button>
            )}
          </div>
        </div>
        <h3 className="font-semibold text-gray-900 dark:text-gray-100 text-sm leading-tight mb-1 truncate">
          {note.title || 'Untitled'}
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2 mb-2">{note.content_preview || 'No content'}</p>
        {note.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {visibleTags.map((tag) => <TagChip key={tag} tag={tag} />)}
            {note.tags.length > 4 && <span className="text-xs text-gray-400 px-1">+{note.tags.length - 4} more</span>}
          </div>
        )}
      </div>
    </div>
  )
}
