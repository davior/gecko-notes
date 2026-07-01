import { Pin, Globe, CheckCircle2 } from 'lucide-react'
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

const textShadow = '0 1px 4px rgba(0,0,0,0.6), 0 0 2px rgba(0,0,0,0.4)'

interface Props {
  note: NoteListItem
  category?: Category
  onClick: (id: string) => void
  onPin?: (id: string) => void
  selected?: boolean
  onToggleSelect?: (id: string) => void
  onShareClick?: (url: string) => void
  viewMode?: 'list' | 'card'
}

export default function NoteCard({ note, category, onClick, onPin, selected = false, onToggleSelect, onShareClick, viewMode = 'list' }: Props) {
  const visibleTags = note.tags.slice(0, 3)

  function handleShareClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (note.share_token && onShareClick) {
      const url = `${window.location.origin}/shared/${note.share_token}`
      onShareClick(url)
    }
  }

  if (viewMode === 'card') {
    const hasImage = Boolean(note.first_image_url)
    return (
      <div
        className={`relative rounded-xl overflow-hidden cursor-pointer h-52 flex flex-col justify-between shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all duration-200 ${
          hasImage
            ? 'border border-gray-200 dark:border-gray-700'
            : 'card'
        } ${selected ? 'ring-2 ring-green-500 ring-offset-1 dark:ring-offset-gray-900' : ''}`}
        onClick={() => onClick(note.id)}
      >
        {/* Background image — fixed blur independent of any active theme */}
        {hasImage && (
          <div
            className="absolute inset-0 bg-cover bg-center"
            style={{ backgroundImage: `url(${note.first_image_url})`, filter: 'blur(3px)', transform: 'scale(1.05)' }}
          />
        )}
        {/* Wash overlay for image cards only — note-card-img-wash suppresses
            backdrop-filter so the static image blur is not compounded by the
            theme glass blur. No-image cards use .card on the outer div instead. */}
        {hasImage && (
          <div className="absolute inset-0 note-card-img-wash bg-white/40 dark:bg-black/50" />
        )}

        {/* Category color accent when no image */}
        {!hasImage && (
          <div className="absolute top-0 left-0 right-0 h-1 rounded-t-xl" style={{ backgroundColor: category?.color ?? '#6B7280' }} />
        )}

        {/* Top row: category + time + pin */}
        <div className="relative z-10 flex items-center justify-between px-3 pt-3 gap-2">
          <div style={hasImage ? { filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.5))' } : undefined}>
            {category
              ? <CategoryBadge category={category} />
              : <span className="text-xs text-gray-400">Uncategorised</span>}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span
              className="text-xs text-gray-500 dark:text-gray-400"
              style={hasImage ? { color: 'white', textShadow } : undefined}
            >
              {relativeDate(note.modified_at)}
            </span>
            {note.is_shared && (
              <button
                title="Shared publicly — click to copy link"
                className="p-0.5 rounded transition-colors text-green-400 hover:bg-white/10"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={handleShareClick}
              >
                <Globe
                  className="w-3.5 h-3.5"
                  style={hasImage ? { color: 'rgba(255,255,255,0.85)' } : undefined}
                />
              </button>
            )}
            {onPin && (
              <button
                className={`p-0.5 rounded transition-colors ${note.is_pinned ? 'text-blue-400' : 'text-gray-300 hover:text-gray-500'}`}
                style={hasImage && !note.is_pinned ? { color: 'rgba(255,255,255,0.7)' } : undefined}
                title={note.is_pinned ? 'Unpin note' : 'Pin to top'}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onPin(note.id) }}
              >
                <Pin className="w-3.5 h-3.5" fill={note.is_pinned ? 'currentColor' : 'none'} />
              </button>
            )}
            {onToggleSelect && (
              <button
                className={`p-0.5 rounded transition-colors ${selected ? 'text-green-500' : 'text-gray-300 hover:text-gray-500'}`}
                style={hasImage && !selected ? { color: 'rgba(255,255,255,0.7)' } : undefined}
                title={selected ? 'Deselect note' : 'Select note'}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onToggleSelect(note.id) }}
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Bottom: title + preview + tags */}
        <div className="relative z-10 px-3 pb-3">
          <h3
            className="font-semibold text-sm leading-tight mb-1 truncate text-gray-900 dark:text-gray-100"
            style={hasImage ? { color: 'white', textShadow } : undefined}
          >
            {note.title || 'Untitled'}
          </h3>
          <p
            className="text-xs text-gray-500 dark:text-gray-400 line-clamp-4 mb-1.5"
            style={hasImage ? { color: 'rgba(255,255,255,0.9)', textShadow } : undefined}
          >
            {note.content_preview || 'No content'}
          </p>
          {visibleTags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {visibleTags.map((tag) => (
                <span
                  key={tag}
                  className={`text-xs px-1.5 py-0.5 rounded-full ${hasImage ? '' : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'}`}
                  style={hasImage
                    ? { backgroundColor: 'rgba(255,255,255,0.25)', color: 'white', textShadow }
                    : undefined}
                >
                  #{tag}
                </span>
              ))}
              {note.tags.length > 3 && (
                <span
                  className={`text-xs px-1 ${hasImage ? '' : 'text-gray-400 dark:text-gray-500'}`}
                  style={hasImage ? { color: 'rgba(255,255,255,0.7)' } : undefined}
                >
                  +{note.tags.length - 3}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  // List view
  return (
    <div
      className={`card cursor-pointer flex overflow-hidden dark:bg-gray-800 dark:border-gray-700 ${selected ? 'ring-2 ring-green-500 ring-offset-1 dark:ring-offset-gray-900' : ''}`}
      onClick={() => onClick(note.id)}
    >
      <div className="w-1 shrink-0 rounded-l-xl" style={{ backgroundColor: category?.color ?? '#6B7280' }} />
      <div className="flex-1 p-4 min-w-0">
        <div className="flex items-center justify-between mb-2 gap-2">
          {category ? <CategoryBadge category={category} /> : <span className="text-xs text-gray-400">Uncategorised</span>}
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-gray-400">{relativeDate(note.modified_at)}</span>
            {note.is_shared && (
              <button
                title="Shared publicly — click to copy link"
                className="p-0.5 rounded transition-colors text-green-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={handleShareClick}
              >
                <Globe className="w-3.5 h-3.5" />
              </button>
            )}
            {onPin && (
              <button
                className={`p-0.5 rounded transition-colors ${note.is_pinned ? 'text-blue-500' : 'text-gray-300 hover:text-gray-500'}`}
                title={note.is_pinned ? 'Unpin note' : 'Pin to top'}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onPin(note.id) }}
              >
                <Pin className="w-3.5 h-3.5" fill={note.is_pinned ? 'currentColor' : 'none'} />
              </button>
            )}
            {onToggleSelect && (
              <button
                className={`p-0.5 rounded transition-colors ${selected ? 'text-green-500' : 'text-gray-300 hover:text-gray-500'}`}
                title={selected ? 'Deselect note' : 'Select note'}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onToggleSelect(note.id) }}
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
        <h3 className="font-semibold text-gray-900 dark:text-gray-100 text-sm leading-tight mb-1 truncate">
          {note.title || 'Untitled'}
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-4 mb-2">{note.content_preview || 'No content'}</p>
        {note.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {note.tags.slice(0, 4).map((tag) => <TagChip key={tag} tag={tag} />)}
            {note.tags.length > 4 && <span className="text-xs text-gray-400 px-1">+{note.tags.length - 4} more</span>}
          </div>
        )}
      </div>
    </div>
  )
}
