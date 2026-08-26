import { useEffect, useRef, useState } from 'react'
import { BookOpen } from 'lucide-react'
import type { Recipe } from '@/api/recipes'

interface RecipePickerDropdownProps {
  recipes: Recipe[]
  disabled?: boolean
  // Run the recipe immediately (execution model, not manual insert-then-send).
  onSelect: (recipe: Recipe) => void
}

// Composer toolbar button: a filterable dropdown of the user's saved recipes
// (Overview: "A dropdown/button in the AI composer shows a filterable list of all the
// available recipes"). Selecting one runs it — see AIConversationPanel's handleRunRecipe.
export default function RecipePickerDropdown({ recipes, disabled, onSelect }: RecipePickerDropdownProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  useEffect(() => {
    if (open) {
      setQuery('')
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const q = query.trim().toLowerCase()
  const filtered = recipes.filter(
    (r) => !q || r.name.toLowerCase().includes(q) || r.tags.some((t) => t.toLowerCase().includes(q)),
  )

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || recipes.length === 0}
        title={recipes.length === 0 ? 'No recipes yet — add one in the Recipes tab' : 'Run a recipe'}
        className={`flex items-center gap-0.5 transition-colors disabled:opacity-40 ${open ? 'text-blue-500' : 'text-gray-400 hover:text-blue-500'}`}
      >
        <BookOpen className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 z-30 w-64 max-w-[80vw] rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg overflow-hidden">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false)
              if (e.key === 'Enter' && filtered[0]) { onSelect(filtered[0]); setOpen(false) }
            }}
            placeholder="Filter recipes…"
            className="w-full text-xs px-2.5 py-2 border-b border-gray-100 dark:border-gray-700 bg-transparent text-gray-700 dark:text-gray-300 focus:outline-none"
          />
          <div className="max-h-56 overflow-y-auto">
            {filtered.length === 0 && (
              <div className="px-2.5 py-3 text-xs text-gray-400 text-center">No recipes match.</div>
            )}
            {filtered.map((recipe) => (
              <button
                key={recipe.id}
                onClick={() => { onSelect(recipe); setOpen(false) }}
                className="w-full text-left px-2.5 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-blue-50 dark:hover:bg-blue-900/20 truncate"
                title={recipe.prompt}
              >
                {recipe.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
