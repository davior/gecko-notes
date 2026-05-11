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
}

export default function NoteCard({ note, category, onClick }: Props) {
  const visibleTags = note.tags.slice(0, 4)

  return (
    <div
      className="card cursor-pointer hover:shadow-md transition-shadow duration-150 flex overflow-hidden"
      onClick={() => onClick(note.id)}
    >
      <div className="w-1 shrink-0 rounded-l-xl" style={{ backgroundColor: category?.color ?? '#6B7280' }} />
      <div className="flex-1 p-4 min-w-0">
        <div className="flex items-center justify-between mb-2 gap-2">
          {category ? <CategoryBadge category={category} /> : <span className="text-xs text-gray-400">Uncategorised</span>}
          <span className="text-xs text-gray-400 shrink-0">{relativeDate(note.modified_at)}</span>
        </div>
        <h3 className="font-semibold text-gray-900 text-sm leading-tight mb-1 truncate">
          {note.title || 'Untitled'}
        </h3>
        <p className="text-xs text-gray-500 line-clamp-2 mb-2">{note.content_preview || 'No content'}</p>
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
