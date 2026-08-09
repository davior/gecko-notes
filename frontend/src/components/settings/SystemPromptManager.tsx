import { useState } from 'react'
import { Plus, Edit2, Trash2, CheckCircle, Circle } from 'lucide-react'
import { useSettingsStore } from '@/stores/settings'
import type { SystemPrompt } from '@/api/settings'

export default function SystemPromptManager() {
  const { systemPrompts, createSystemPrompt, updateSystemPrompt, deleteSystemPrompt, activateSystemPrompt } =
    useSettingsStore()

  const [editing, setEditing] = useState<SystemPrompt | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [formName, setFormName] = useState('')
  const [formContent, setFormContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  function openAdd() {
    setEditing(null)
    setFormName('')
    setFormContent('')
    setShowForm(true)
  }

  function openEdit(prompt: SystemPrompt) {
    setEditing(prompt)
    setFormName(prompt.name)
    setFormContent(prompt.content)
    setShowForm(true)
  }

  function closeForm() {
    setShowForm(false)
    setEditing(null)
    setFormName('')
    setFormContent('')
  }

  async function handleSave() {
    if (!formName.trim() || !formContent.trim()) return
    setSaving(true)
    try {
      if (editing) {
        await updateSystemPrompt(editing.id, { name: formName.trim(), content: formContent.trim() })
      } else {
        await createSystemPrompt({ name: formName.trim(), content: formContent.trim() })
      }
      closeForm()
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    await deleteSystemPrompt(id)
    setDeleteConfirmId(null)
  }

  async function handleActivate(id: string) {
    await activateSystemPrompt(id)
  }

  const sorted = [...systemPrompts].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">AI Agents</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Named agents whose system prompts steer AI behaviour. One can be set as the active default.
          </p>
        </div>
        <button className="btn-primary flex items-center gap-1.5 text-sm py-1.5 px-3" onClick={openAdd}>
          <Plus className="w-4 h-4" />
          Add
        </button>
      </div>

      {showForm && (
        <div className="card p-4 mb-4 space-y-3 border-blue-200 dark:border-blue-700 bg-blue-50/50 dark:bg-blue-900/10">
          <h4 className="text-sm font-medium text-gray-800 dark:text-gray-200">
            {editing ? 'Edit AI Agent' : 'New AI Agent'}
          </h4>
          <div>
            <label className="label">Name</label>
            <input
              className="input"
              placeholder="e.g. Concise helper"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Prompt content</label>
            <textarea
              className="input min-h-[120px] resize-y font-mono text-xs"
              placeholder="You are a helpful assistant..."
              value={formContent}
              onChange={(e) => setFormContent(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <button
              className="btn-primary text-sm py-1.5 px-4"
              disabled={saving || !formName.trim() || !formContent.trim()}
              onClick={handleSave}
            >
              {saving ? 'Saving...' : editing ? 'Save Changes' : 'Create'}
            </button>
            <button className="btn-secondary text-sm py-1.5 px-4" onClick={closeForm}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {sorted.length === 0 && !showForm ? (
        <div className="card p-6 text-center text-sm text-gray-400 dark:text-gray-500">
          No AI agents yet. Add one to customise AI behaviour.
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map((prompt) => (
            <div
              key={prompt.id}
              className={`card p-4 flex items-start gap-3 ${prompt.is_active ? 'border-blue-300 dark:border-blue-600 bg-blue-50/40 dark:bg-blue-900/10' : ''}`}
            >
              <button
                className="mt-0.5 shrink-0 text-gray-300 dark:text-gray-600 hover:text-blue-500 dark:hover:text-blue-400 transition-colors"
                title={prompt.is_active ? 'Active' : 'Set as active'}
                onClick={() => !prompt.is_active && handleActivate(prompt.id)}
              >
                {prompt.is_active ? (
                  <CheckCircle className="w-5 h-5 text-blue-500 dark:text-blue-400" />
                ) : (
                  <Circle className="w-5 h-5" />
                )}
              </button>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{prompt.name}</span>
                  {prompt.is_active && (
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400 font-medium">
                      Active
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">{prompt.content}</p>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <button
                  className="btn-ghost p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                  title="Edit"
                  onClick={() => openEdit(prompt)}
                >
                  <Edit2 className="w-3.5 h-3.5" />
                </button>
                {deleteConfirmId === prompt.id ? (
                  <div className="flex items-center gap-1">
                    <button
                      className="text-xs px-2 py-1 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 hover:bg-red-200"
                      onClick={() => handleDelete(prompt.id)}
                    >
                      Confirm
                    </button>
                    <button
                      className="text-xs px-2 py-1 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
                      onClick={() => setDeleteConfirmId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn-ghost p-1.5 text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                    title="Delete"
                    onClick={() => setDeleteConfirmId(prompt.id)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
