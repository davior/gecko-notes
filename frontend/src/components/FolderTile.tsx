import { resolveFolderIcon } from '@/utils/folderIcons'
import type { Folder } from '@/api/folders'

interface Props {
  folder: Pick<Folder, 'name' | 'icon_type' | 'icon_value' | 'color'>
  size?: number // icon container size in px
}

// Single source of truth for how a folder's icon + color render, shared by the
// live folder chip bar and the customize modal's live preview.
export default function FolderTile({ folder, size = 32 }: Props) {
  const resolved = resolveFolderIcon(folder)
  const tint = folder.color ? `${folder.color}22` : undefined

  return (
    <div className="flex flex-col items-center gap-1 w-20 min-w-0">
      <div
        className="rounded-lg flex items-center justify-center shrink-0"
        style={{ width: size, height: size, backgroundColor: tint }}
      >
        {resolved.kind === 'emoji' ? (
          <span style={{ fontSize: size * 0.55, lineHeight: 1 }}>{resolved.emoji}</span>
        ) : (
          <resolved.Icon
            style={{ width: size * 0.6, height: size * 0.6, color: folder.color ?? undefined }}
            className={folder.color ? undefined : 'text-blue-500'}
          />
        )}
      </div>
      <span className="text-xs font-medium text-gray-700 dark:text-gray-200 truncate max-w-[5rem] text-center">
        {folder.name}
      </span>
    </div>
  )
}
