import { Search, X } from 'lucide-react'

interface Props {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  autoFocus?: boolean
  className?: string
}

/** Name filter for a folder tree: a search field with an "x" at the end of the line that
 *  clears it (Escape does too). */
export default function FolderFilterInput({
  value,
  onChange,
  placeholder = 'Filter folders…',
  autoFocus = false,
  className = '',
}: Props) {
  return (
    <div className={`relative ${className}`}>
      <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape' && value) { e.stopPropagation(); onChange('') } }}
        placeholder={placeholder}
        aria-label="Filter folders"
        autoFocus={autoFocus}
        className="w-full pl-7 pr-7 py-1 text-sm rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-800 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
      />
      {value && (
        <button
          type="button"
          className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600"
          title="Clear filter"
          aria-label="Clear filter"
          onClick={() => onChange('')}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  )
}
