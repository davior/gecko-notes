import { useState, useEffect, useMemo } from 'react'
import { Home } from 'lucide-react'
import { foldersApi, type Folder } from '@/api/folders'
import { resolveFolderIcon } from '@/utils/folderIcons'
import { buildTree, isDynamicFolder } from '@/utils/folderTree'

interface Props {
  title?: string
  // Folder ids that cannot be chosen as a destination (e.g. the item being
  // moved and its descendants, to avoid cycles).
  disabledIds?: Set<string>
  onSelect: (folderId: string | null) => void
  onClose: () => void
}

export default function FolderPickerModal({ title = 'Move to folder', disabledIds, onSelect, onClose }: Props) {
  const [folders, setFolders] = useState<Folder[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    foldersApi.list()
      .then((r) => { if (active) setFolders(r.data) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  // Dynamic (saved-search) folders are leaves that hold nothing, so they can't be a
  // move destination.
  const tree = useMemo(() => buildTree(folders.filter((f) => !isDynamicFolder(f))), [folders])

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-xl p-5 max-w-sm w-full mx-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">{title}</h3>
        <div className="max-h-72 overflow-y-auto -mx-1">
          <button
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
            onClick={() => onSelect(null)}
          >
            <Home className="w-4 h-4 text-gray-400" /> All notes (root)
          </button>
          {loading ? (
            <p className="text-sm text-gray-400 px-3 py-2">Loading…</p>
          ) : tree.length === 0 ? (
            <p className="text-sm text-gray-400 px-3 py-2">No folders yet.</p>
          ) : (
            tree.map((f) => {
              const disabled = disabledIds?.has(f.id)
              const resolved = resolveFolderIcon(f)
              return (
                <button
                  key={f.id}
                  disabled={disabled}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                    disabled
                      ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                      : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'
                  }`}
                  style={{ paddingLeft: `${0.75 + f.depth * 1.1}rem` }}
                  onClick={() => onSelect(f.id)}
                >
                  {resolved.kind === 'emoji' ? (
                    <span className="text-sm leading-none shrink-0">{resolved.emoji}</span>
                  ) : (
                    <resolved.Icon
                      className={`w-4 h-4 shrink-0 ${f.color || disabled ? '' : 'text-blue-500'}`}
                      style={{ color: disabled ? undefined : f.color ?? undefined }}
                    />
                  )}
                  <span className="truncate">{f.name}</span>
                </button>
              )
            })
          )}
        </div>
        <div className="flex justify-end mt-4">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
