import { createPortal } from 'react-dom'
import { ChevronDown, Check } from 'lucide-react'
import { useCategoriesStore } from '@/stores/categories'
import { useDropdown } from '@/hooks/useDropdown'

interface Props {
  value: string
  onChange: (id: string) => void
}

export default function CategoryPicker({ value, onChange }: Props) {
  const categories = useCategoriesStore((s) => s.categories)
  const getCategoryById = useCategoriesStore((s) => s.getCategoryById)
  const selected = getCategoryById(value)
  const { open, setOpen, triggerRef, dropdownRef, style } = useDropdown('left')

  function select(id: string) {
    onChange(id)
    setOpen(false)
  }

  return (
    <div className="relative" ref={triggerRef}>
      <button
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-sm hover:border-gray-300 hover:bg-gray-50 transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        {selected ? (
          <span>{selected.emoji} {selected.label}</span>
        ) : (
          <span className="text-gray-400">Select category</span>
        )}
        <ChevronDown className="w-4 h-4 text-gray-400" />
      </button>

      {open && createPortal(
        <div
          ref={dropdownRef}
          className="z-50 mt-1 w-56 bg-white rounded-xl border border-gray-200 shadow-lg overflow-hidden"
          style={style}
        >
          <div className="p-1">
            {categories.map((cat) => (
              <button
                key={cat.id}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors text-left ${cat.id === value ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-50'}`}
                onMouseDown={(e) => { e.preventDefault(); select(cat.id) }}
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: cat.color }} />
                <span>{cat.emoji}</span>
                <span>{cat.label}</span>
                {cat.id === value && <Check className="w-4 h-4 ml-auto text-blue-600" />}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
