import { useState } from 'react'
import { useFoldersStore } from '@/stores/folders'
import type { Folder, FolderIconType } from '@/api/folders'
import { FOLDER_ICON_CATALOGUE, FOLDER_COLOR_PRESETS } from '@/utils/folderIcons'
import FolderTile from './FolderTile'

interface Props {
  folder?: Folder | null       // present => editing an existing folder; absent => creating
  parentFolderId?: string | null  // used only when creating
  isDynamicFolder?: boolean    // create a dynamic (saved-search) folder; ignored when editing
  onClose: () => void
}

const DEFAULT_COLOR = FOLDER_COLOR_PRESETS[6] // blue, matches the pre-customization default look
const DEFAULT_EMOJI = '📁'
const DEFAULT_ICON_NAME = 'Folder'
const ICON_NAMES = Object.keys(FOLDER_ICON_CATALOGUE)

export default function FolderCustomizeModal({ folder, parentFolderId = null, isDynamicFolder = false, onClose }: Props) {
  const { createFolder, updateFolder } = useFoldersStore()
  const isEdit = !!folder
  // A dynamic folder runs a saved search on click. When editing, the folder's own
  // search_query decides; when creating, the caller opts in via isDynamicFolder.
  const isDynamic = folder ? folder.search_query != null : isDynamicFolder

  const [name, setName] = useState(folder?.name ?? '')
  const [query, setQuery] = useState(folder?.search_query ?? '')
  const [iconTab, setIconTab] = useState<'icon' | 'emoji'>(folder?.icon_type === 'emoji' ? 'emoji' : 'icon')
  const [emoji, setEmoji] = useState(folder?.icon_type === 'emoji' && folder.icon_value ? folder.icon_value : DEFAULT_EMOJI)
  const [iconName, setIconName] = useState(
    folder?.icon_type === 'lucide' && folder.icon_value
      ? folder.icon_value
      : isDynamic && !folder ? 'Search' : DEFAULT_ICON_NAME,
  )
  const [color, setColor] = useState(folder?.color ?? DEFAULT_COLOR)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const iconType: FolderIconType = iconTab === 'emoji' ? 'emoji' : 'lucide'
  const iconValue = iconTab === 'emoji' ? emoji : iconName
  const previewName = name.trim() || (isDynamic ? 'New Dynamic Folder' : 'New Folder')
  const previewFolder = { name: previewName, icon_type: iconType, icon_value: iconValue, color }
  const canSave = !!name.trim() && !(isDynamic && !query.trim())

  async function handleSave() {
    if (!canSave) return
    const trimmed = name.trim()
    setSaving(true)
    setError('')
    try {
      const payload = {
        name: trimmed,
        icon_type: iconType,
        icon_value: iconValue,
        color,
        ...(isDynamic ? { search_query: query.trim() } : {}),
      }
      if (folder) {
        await updateFolder(folder.id, payload)
      } else {
        await createFolder({ ...payload, parent_folder_id: parentFolderId })
      }
      onClose()
    } catch {
      setError('Failed to save folder')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-xl p-5 max-w-sm w-full mx-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {isEdit
            ? (isDynamic ? 'Customize Dynamic Folder' : 'Customize Folder')
            : (isDynamic ? 'New Dynamic Folder' : 'New Folder')}
        </h3>

        <div className="flex justify-center mb-4">
          <FolderTile folder={previewFolder} size={48} />
        </div>

        <div className="space-y-4">
          <div>
            <label className="label">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              type="text"
              className="input"
              placeholder={isDynamic ? 'e.g. Last seven days' : 'Folder name'}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSave() }}
            />
          </div>

          {isDynamic && (
            <div>
              <label className="label">Search query</label>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                type="text"
                className="input"
                placeholder="e.g. all notes from the last week"
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSave() }}
              />
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                Runs this search when you open the folder.
              </p>
            </div>
          )}

          <div>
            <label className="label">Icon</label>
            <div className="flex gap-1 mb-2 p-1 bg-gray-100 dark:bg-gray-700 rounded-lg w-fit">
              <button
                type="button"
                className={`text-xs px-3 py-1 rounded-md transition-colors ${
                  iconTab === 'icon' ? 'bg-white dark:bg-gray-800 shadow-sm text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'
                }`}
                onClick={() => setIconTab('icon')}
              >
                Icon
              </button>
              <button
                type="button"
                className={`text-xs px-3 py-1 rounded-md transition-colors ${
                  iconTab === 'emoji' ? 'bg-white dark:bg-gray-800 shadow-sm text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'
                }`}
                onClick={() => setIconTab('emoji')}
              >
                Emoji
              </button>
            </div>

            {iconTab === 'emoji' ? (
              <input
                value={emoji}
                onChange={(e) => setEmoji(e.target.value)}
                type="text"
                className="input w-20 text-center text-xl"
                maxLength={4}
              />
            ) : (
              <div className="grid grid-cols-8 gap-1 max-h-32 overflow-y-auto p-1 border border-gray-200 dark:border-gray-700 rounded-lg">
                {ICON_NAMES.map((n) => {
                  const Icon = FOLDER_ICON_CATALOGUE[n]
                  const selected = iconName === n
                  return (
                    <button
                      key={n}
                      type="button"
                      title={n}
                      className={`p-1.5 rounded-md flex items-center justify-center transition-colors ${
                        selected
                          ? 'bg-blue-100 dark:bg-blue-900/40 ring-2 ring-blue-400'
                          : 'hover:bg-gray-100 dark:hover:bg-gray-700'
                      }`}
                      onClick={() => setIconName(n)}
                    >
                      <Icon className="w-4 h-4 text-gray-700 dark:text-gray-200" />
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div>
            <label className="label">Color</label>
            <div className="flex items-center gap-2 flex-wrap">
              {FOLDER_COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  title={c}
                  className={`w-6 h-6 rounded-full shrink-0 transition-transform ${
                    color === c ? 'ring-2 ring-offset-2 ring-gray-400 dark:ring-offset-gray-800 scale-110' : ''
                  }`}
                  style={{ backgroundColor: c }}
                  onClick={() => setColor(c)}
                />
              ))}
              <input
                value={color}
                onChange={(e) => setColor(e.target.value)}
                type="color"
                className="w-8 h-8 rounded-lg border border-gray-300 cursor-pointer shrink-0"
                title="Custom color"
              />
            </div>
          </div>
        </div>

        {error && <p className="text-sm text-red-500 mt-3">{error}</p>}

        <div className="flex gap-3 mt-5">
          <button className="btn-primary flex-1" disabled={!canSave || saving} onClick={handleSave}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
