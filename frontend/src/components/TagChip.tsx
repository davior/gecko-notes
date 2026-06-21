interface Props {
  tag: string
  removable?: boolean
  onRemove?: (tag: string) => void
  onClick?: (tag: string) => void
}

export default function TagChip({ tag, removable, onRemove, onClick }: Props) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-700 border border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600">
      {onClick ? (
        <button
          type="button"
          className="cursor-pointer hover:underline focus:outline-none"
          title="Copy tag"
          onClick={(e) => { e.stopPropagation(); onClick(tag) }}
        >
          #{tag}
        </button>
      ) : (
        <span>#{tag}</span>
      )}
      {removable && (
        <button
          className="ml-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 focus:outline-none"
          aria-label={`Remove tag ${tag}`}
          onClick={(e) => { e.stopPropagation(); onRemove?.(tag) }}
        >
          <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </button>
      )}
    </span>
  )
}
