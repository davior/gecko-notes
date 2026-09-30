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

/** True if the folder is a dynamic (saved-search) folder: clicking it runs its query
 *  instead of opening a directory, and it holds no notes/subfolders. */
export function isDynamicFolder(folder: Pick<Folder, 'search_query'>): boolean {
  return folder.search_query != null
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

/** Ids of the folders a name filter keeps: every folder whose name contains `query`
 *  (case-insensitive) plus all their ancestors, so a match is always reachable from the
 *  root. Returns null for a blank query, meaning "no filtering — show everything". */
export function folderFilterIds(folders: Folder[], query: string): Set<string> | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  const byId = indexById(folders)
  const keep = new Set<string>()
  for (const f of folders) {
    if (!f.name.toLowerCase().includes(q)) continue
    keep.add(f.id)
    for (const a of ancestorIds(f.id, byId)) keep.add(a)
  }
  return keep
}

/** Drop every node of a nested forest whose folder isn't in `keep`. */
export function pruneForest(forest: FolderNode[], keep: Set<string>): FolderNode[] {
  return forest
    .filter((n) => keep.has(n.folder.id))
    .map((n) => ({ folder: n.folder, children: pruneForest(n.children, keep) }))
}

/** What a folder context menu was opened on. `create` is "add something here" — the
 *  "All notes" root row (folderId null) or the background of the folder being viewed. */
export type FolderMenuTarget =
  | { kind: 'create'; folderId: string | null }
  | { kind: 'normal' | 'archived' | 'dynamic'; folder: Folder }
  | { kind: 'bin' }

/** Which menu a folder gets: the Archive Bin, anything inside the bin, a saved-search
 *  folder (a leaf), or an ordinary folder. */
export function folderMenuTarget(
  folder: Folder,
  archiveId: string | null,
  byId: Map<string, Folder>,
): FolderMenuTarget {
  if (folder.id === archiveId) return { kind: 'bin' }
  if (isDynamicFolder(folder)) return { kind: 'dynamic', folder }
  if (isInArchive(folder.id, byId, archiveId)) return { kind: 'archived', folder }
  return { kind: 'normal', folder }
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
