import type { Folder } from '@/api/folders'

// Mirrors the backend Folder.system_key value that marks the per-user Archive Bin.
export const ARCHIVE_SYSTEM_KEY = 'archive'

export interface TreeNode extends Folder {
  depth: number
}

/** Nested folder node, for a real expand/collapse tree (vs the flat TreeNode list). */
export interface FolderNode {
  folder: Folder
  children: FolderNode[]
}

function groupByParent(folders: Folder[]): Map<string | null, Folder[]> {
  const byParent = new Map<string | null, Folder[]>()
  for (const f of folders) {
    const key = f.parent_folder_id
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key)!.push(f)
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
  }
  return byParent
}

/** Flatten the folder list into a depth-ordered tree for an indented picker. */
export function buildTree(folders: Folder[]): TreeNode[] {
  const byParent = groupByParent(folders)
  const out: TreeNode[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const f of byParent.get(parent) ?? []) {
      out.push({ ...f, depth })
      walk(f.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/** Build the nested folder forest (top-level nodes with recursive children). */
export function buildForest(folders: Folder[]): FolderNode[] {
  const byParent = groupByParent(folders)
  const build = (parent: string | null): FolderNode[] =>
    (byParent.get(parent) ?? []).map((f) => ({ folder: f, children: build(f.id) }))
  return build(null)
}

export function indexById(folders: Folder[]): Map<string, Folder> {
  return new Map(folders.map((f) => [f.id, f]))
}

export function findArchiveFolder(folders: Folder[]): Folder | null {
  return folders.find((f) => f.system_key === ARCHIVE_SYSTEM_KEY) ?? null
}

/** Ancestor ids of a folder (excluding itself), nearest parent first — for auto-expand. */
export function ancestorIds(folderId: string, byId: Map<string, Folder>, maxDepth = 100): string[] {
  const out: string[] = []
  let cur = byId.get(folderId)?.parent_folder_id ?? null
  let seen = 0
  while (cur && seen < maxDepth) {
    out.push(cur)
    cur = byId.get(cur)?.parent_folder_id ?? null
    seen++
  }
  return out
}

/** True if folderId is the Archive Bin itself or lives anywhere inside it. */
export function isInArchive(
  folderId: string | null,
  byId: Map<string, Folder>,
  archiveId: string | null,
): boolean {
  if (!folderId || !archiveId) return false
  let cur: string | null = folderId
  let seen = 0
  while (cur && seen < 100) {
    if (cur === archiveId) return true
    cur = byId.get(cur)?.parent_folder_id ?? null
    seen++
  }
  return false
}
