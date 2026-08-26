import { useMemo, useRef, useState } from 'react'
import { Plus, Pencil, Trash2, Play, Search, Download, Upload, X, FlaskConical } from 'lucide-react'
import type { Recipe, RecipeCreate, RecipeUpdate } from '@/api/recipes'
import TagChip from '@/components/TagChip'
import { renderRecipePrompt, RECIPE_VARIABLE_HELP, type RecipeVariableContext } from '@/utils/recipeVariables'

interface RecipesPanelProps {
  recipes: Recipe[]
  loading: boolean
  onCreate: (payload: RecipeCreate) => Promise<Recipe>
  onUpdate: (id: string, payload: RecipeUpdate) => Promise<Recipe>
  onDelete: (id: string) => Promise<void>
  // Run the recipe's (already-substituted) prompt in the chat — switches to the Chat tab.
  onRun: (recipe: Recipe) => void
  // Current note title / selection, for placeholder substitution in the live preview.
  previewContext: RecipeVariableContext
  disabled?: boolean
}

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

interface RecipeExport {
  name: string
  prompt: string
  tags: string[]
}

export default function RecipesPanel({
  recipes,
  loading,
  onCreate,
  onUpdate,
  onDelete,
  onRun,
  previewContext,
  disabled,
}: RecipesPanelProps) {
  const [search, setSearch] = useState('')
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [editing, setEditing] = useState<Recipe | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [formName, setFormName] = useState('')
  const [formPrompt, setFormPrompt] = useState('')
  const [formTags, setFormTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [importSummary, setImportSummary] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const allTags = useMemo(() => {
    const s = new Set<string>()
    recipes.forEach((r) => r.tags.forEach((t) => s.add(t)))
    return [...s].sort()
  }, [recipes])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return recipes
      .filter((r) => !activeTag || r.tags.includes(activeTag))
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.prompt.toLowerCase().includes(q))
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
  }, [recipes, search, activeTag])

  function openAdd() {
    setEditing(null)
    setFormName('')
    setFormPrompt('')
    setFormTags([])
    setTagInput('')
    setShowForm(true)
  }

  function openEdit(recipe: Recipe) {
    setEditing(recipe)
    setFormName(recipe.name)
    setFormPrompt(recipe.prompt)
    setFormTags([...recipe.tags])
    setTagInput('')
    setShowForm(true)
  }

  function closeForm() {
    setShowForm(false)
    setEditing(null)
  }

  function addTagFromInput() {
    const raw = tagInput.trim().replace(/^#/, '').toLowerCase()
    if (raw && !formTags.includes(raw)) setFormTags((t) => [...t, raw])
    setTagInput('')
  }

  async function handleSave() {
    if (!formName.trim() || !formPrompt.trim()) return
    setSaving(true)
    try {
      if (editing) {
        await onUpdate(editing.id, { name: formName.trim(), prompt: formPrompt.trim(), tags: formTags })
      } else {
        await onCreate({ name: formName.trim(), prompt: formPrompt.trim(), tags: formTags })
      }
      closeForm()
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    await onDelete(id)
    setDeleteConfirmId(null)
  }

  function handleExport() {
    const data: RecipeExport[] = recipes.map((r) => ({ name: r.name, prompt: r.prompt, tags: r.tags }))
    downloadJson(data, 'gecko-notes-recipes.json')
  }

  async function handleImportFile(file: File) {
    setImportSummary('')
    try {
      const text = await file.text()
      const parsed: unknown = JSON.parse(text)
      const list = Array.isArray(parsed) ? parsed : []
      let imported = 0
      for (const item of list) {
        if (!item || typeof item !== 'object') continue
        const name = (item as Record<string, unknown>).name
        const prompt = (item as Record<string, unknown>).prompt
        const rawTags = (item as Record<string, unknown>).tags
        if (typeof name !== 'string' || typeof prompt !== 'string' || !name.trim() || !prompt.trim()) continue
        const tags = Array.isArray(rawTags) ? rawTags.filter((t): t is string => typeof t === 'string') : []
        await onCreate({ name: name.trim(), prompt: prompt.trim(), tags })
        imported++
      }
      setImportSummary(
        imported > 0 ? `Imported ${imported} recipe${imported === 1 ? '' : 's'}.` : 'No valid recipes found in that file.',
      )
    } catch {
      setImportSummary('Import failed — not a valid recipe export file.')
    }
  }

  const preview = formPrompt.trim() ? renderRecipePrompt(formPrompt, previewContext) : ''

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="shrink-0 px-3 pt-2 pb-1.5 space-y-1.5 border-b border-gray-100 dark:border-gray-700">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1 min-w-0">
            <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter recipes…"
              className="w-full text-xs pl-7 pr-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
            />
          </div>
          <button
            className="btn-ghost p-1.5 shrink-0"
            title="Export recipes as JSON"
            onClick={handleExport}
            disabled={recipes.length === 0}
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          <button className="btn-ghost p-1.5 shrink-0" title="Import recipes from JSON" onClick={() => fileInputRef.current?.click()}>
            <Upload className="w-3.5 h-3.5" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void handleImportFile(file)
            }}
          />
          <button className="btn-ghost p-1.5 shrink-0 text-blue-500" title="New recipe" onClick={openAdd}>
            <Plus className="w-4 h-4" />
          </button>
        </div>
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {allTags.map((tag) => (
              <button
                key={tag}
                onClick={() => setActiveTag((t) => (t === tag ? null : tag))}
                className={`text-[11px] px-1.5 py-0.5 rounded-full border transition-colors ${
                  activeTag === tag
                    ? 'bg-blue-500 border-blue-500 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:border-blue-300'
                }`}
              >
                #{tag}
              </button>
            ))}
          </div>
        )}
        {importSummary && (
          <div className="text-[11px] text-gray-500 dark:text-gray-400 flex items-center justify-between gap-2">
            <span>{importSummary}</span>
            <button onClick={() => setImportSummary('')} className="text-gray-400 hover:text-gray-600">
              <X className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>

      {/* Add/Edit form */}
      {showForm && (
        <div className="shrink-0 px-3 py-2.5 space-y-2 border-b border-gray-100 dark:border-gray-700 bg-blue-50/50 dark:bg-blue-900/10">
          <input
            autoFocus
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder="Recipe name (e.g. Summarize this note)"
            className="input text-sm py-1.5"
          />
          <textarea
            value={formPrompt}
            onChange={(e) => setFormPrompt(e.target.value)}
            placeholder="Prompt… use {{title}}, {{selected text}}, {{date}}"
            rows={4}
            className="input text-sm py-1.5 resize-y font-mono text-xs"
          />
          <div className="text-[10px] text-gray-400 dark:text-gray-500">
            {RECIPE_VARIABLE_HELP.map((v) => v.token).join('  ·  ')}
          </div>
          {preview && (
            <div className="text-xs rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2 text-gray-600 dark:text-gray-300 max-h-24 overflow-y-auto whitespace-pre-wrap">
              <span className="block text-[10px] uppercase tracking-wide text-gray-400 mb-0.5">Preview</span>
              {preview}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1">
            {formTags.map((tag) => (
              <TagChip key={tag} tag={tag} removable onRemove={(t) => setFormTags((ts) => ts.filter((x) => x !== t))} />
            ))}
            <input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); addTagFromInput() }
              }}
              onBlur={addTagFromInput}
              placeholder="+ tag"
              className="text-xs border-none bg-transparent focus:outline-none w-16 text-gray-500 dark:text-gray-400"
            />
          </div>
          <div className="flex gap-2 pt-0.5">
            <button
              className="btn-primary text-xs py-1.5 px-3"
              disabled={saving || !formName.trim() || !formPrompt.trim()}
              onClick={handleSave}
            >
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Create'}
            </button>
            {formPrompt.trim() && (
              <button
                className="text-xs py-1.5 px-3 rounded-lg border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                title={disabled ? 'Configure an AI provider first' : 'Run this prompt in the current chat'}
                disabled={disabled}
                onClick={() => {
                  const draft: Recipe = {
                    id: editing?.id ?? 'draft',
                    name: formName.trim() || 'Untitled recipe',
                    prompt: formPrompt.trim(),
                    tags: formTags,
                    sort_order: 0,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                  }
                  onRun(draft)
                }}
              >
                <FlaskConical className="w-3 h-3" />
                Test
              </button>
            )}
            <button className="text-xs py-1.5 px-3 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" onClick={closeForm}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {!loading && filtered.length === 0 && (
          <div className="px-3 py-8 text-sm text-gray-400 text-center">
            {recipes.length === 0 ? 'No recipes yet. Add one to get started.' : 'No recipes match.'}
          </div>
        )}
        {filtered.map((recipe) => (
          <div
            key={recipe.id}
            className="group px-3 py-2.5 border-b border-gray-50 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/60"
          >
            <div className="flex items-start gap-1.5">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">{recipe.name}</div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">{recipe.prompt}</p>
                {recipe.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {recipe.tags.map((tag) => (
                      <TagChip key={tag} tag={tag} />
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  className="p-1 text-blue-400 hover:text-blue-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  title={disabled ? 'Configure an AI provider first' : 'Run recipe'}
                  disabled={disabled}
                  onClick={() => onRun(recipe)}
                >
                  <Play className="w-3.5 h-3.5" />
                </button>
                <button
                  className="p-1 text-gray-300 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Edit"
                  onClick={() => openEdit(recipe)}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  className="p-1 text-gray-300 dark:text-gray-600 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Delete"
                  onClick={() => setDeleteConfirmId(recipe.id)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            {deleteConfirmId === recipe.id && (
              <div className="flex items-center gap-2 mt-1.5">
                <span className="text-xs text-gray-500">Delete this recipe?</span>
                <button
                  className="text-xs px-2 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 hover:bg-red-200"
                  onClick={() => void handleDelete(recipe.id)}
                >
                  Confirm
                </button>
                <button
                  className="text-xs px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
                  onClick={() => setDeleteConfirmId(null)}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
