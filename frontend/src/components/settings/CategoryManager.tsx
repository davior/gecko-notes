import { useState } from 'react'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import { useCategoriesStore } from '@/stores/categories'
import type { Category } from '@/api/categories'

interface FormData { label: string; emoji: string; color: string }
const defaultForm = (): FormData => ({ label: '', emoji: '📝', color: '#3B82F6' })

export default function CategoryManager() {
  const { categories, createCategory, updateCategory, deleteCategory } = useCategoriesStore()
  const [addingNew, setAddingNew] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [newForm, setNewForm] = useState<FormData>(defaultForm())
  const [editForm, setEditForm] = useState<FormData>(defaultForm())
  const [errorMsg, setErrorMsg] = useState('')

  function showError(msg: string) {
    setErrorMsg(msg)
    setTimeout(() => setErrorMsg(''), 3000)
  }

  function startAddNew() {
    setNewForm(defaultForm())
    setAddingNew(true)
    setEditingId(null)
  }

  function startEdit(cat: Category) {
    setEditForm({ label: cat.label, emoji: cat.emoji, color: cat.color })
    setEditingId(cat.id)
    setAddingNew(false)
  }

  async function saveNew() {
    if (!newForm.label.trim()) return
    try {
      await createCategory({ label: newForm.label.trim(), emoji: newForm.emoji, color: newForm.color, sort_order: categories.length })
      setAddingNew(false)
    } catch { showError('Failed to create category') }
  }

  async function saveEdit(id: string) {
    try {
      await updateCategory(id, { label: editForm.label.trim(), emoji: editForm.emoji, color: editForm.color })
      setEditingId(null)
    } catch { showError('Failed to update category') }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this category?')) return
    try {
      await deleteCategory(id)
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: { message?: string } } } })
        ?.response?.data?.detail
      showError(detail?.message ?? 'Failed to delete category')
    }
  }

  function FormFields({ form, onChange }: { form: FormData; onChange: (f: FormData) => void }) {
    return (
      <div className="flex gap-3">
        <div className="w-24">
          <label className="label">Emoji</label>
          <input value={form.emoji} onChange={(e) => onChange({ ...form, emoji: e.target.value })} type="text" className="input text-center text-xl" maxLength={4} />
        </div>
        <div className="flex-1">
          <label className="label">Label</label>
          <input value={form.label} onChange={(e) => onChange({ ...form, label: e.target.value })} type="text" className="input" placeholder="Category name" />
        </div>
        <div className="w-24">
          <label className="label">Color</label>
          <input value={form.color} onChange={(e) => onChange({ ...form, color: e.target.value })} type="color" className="w-full h-9 rounded-lg border border-gray-300 cursor-pointer" />
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Categories</h2>
        <button className="btn-primary text-sm" onClick={startAddNew}>
          <Plus className="w-4 h-4" /> Add Category
        </button>
      </div>

      <div className="space-y-2">
        {addingNew && (
          <div className="card p-4 border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">New Category</h3>
            <div className="flex flex-col gap-3">
              <FormFields form={newForm} onChange={setNewForm} />
              <div className="flex gap-2">
                <button className="btn-primary text-sm flex-1" disabled={!newForm.label.trim()} onClick={saveNew}>Save</button>
                <button className="btn-secondary text-sm flex-1" onClick={() => setAddingNew(false)}>Cancel</button>
              </div>
            </div>
          </div>
        )}

        {categories.map((cat) => (
          <div key={cat.id} className="card p-4">
            {editingId === cat.id ? (
              <div className="flex flex-col gap-3">
                <FormFields form={editForm} onChange={setEditForm} />
                <div className="flex gap-2">
                  <button className="btn-primary text-sm flex-1" onClick={() => saveEdit(cat.id)}>Save</button>
                  <button className="btn-secondary text-sm flex-1" onClick={() => setEditingId(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg shrink-0 flex items-center justify-center text-lg" style={{ backgroundColor: cat.color + '22' }}>
                  {cat.emoji}
                </div>
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: cat.color }} />
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{cat.label}</span>
                  {cat.is_default && <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 px-2 py-0.5 rounded-full">Default</span>}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button className="btn-ghost p-1.5" title="Edit" onClick={() => startEdit(cat)}>
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    className="btn-ghost p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-30 disabled:cursor-not-allowed"
                    title="Delete"
                    disabled={cat.is_default}
                    onClick={() => !cat.is_default && handleDelete(cat.id)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}

        {categories.length === 0 && !addingNew && (
          <div className="text-center text-gray-400 dark:text-gray-500 py-8 text-sm">No categories yet. Add one to get started.</div>
        )}
      </div>

      {errorMsg && (
        <div className="fixed bottom-4 right-4 bg-red-600 text-white px-4 py-3 rounded-xl shadow-lg text-sm z-50">{errorMsg}</div>
      )}
    </div>
  )
}
