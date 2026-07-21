import client from './client'

export type FolderIconType = 'emoji' | 'lucide'

export interface Folder {
  id: string
  name: string
  parent_folder_id: string | null
  sort_order: number
  icon_type: FolderIconType | null
  icon_value: string | null
  color: string | null
  system_key: string | null   // 'archive' => the Archive Bin; null => normal folder
  created_at: string
  modified_at: string
}

export interface FolderContents {
  folder: Folder | null
  breadcrumb: Folder[]
  subfolders: Folder[]
}

export interface FolderCreate {
  name: string
  parent_folder_id?: string | null
  sort_order?: number
  icon_type?: FolderIconType | null
  icon_value?: string | null
  color?: string | null
}

export interface FolderUpdate {
  name?: string
  parent_folder_id?: string | null
  sort_order?: number
  icon_type?: FolderIconType | null
  icon_value?: string | null
  color?: string | null
}

export const foldersApi = {
  // Flat list of all the user's folders (used by the move-to picker).
  list(): Promise<{ data: Folder[]; total: number; limit: number; offset: number }> {
    return client.get('/folders').then((r) => r.data)
  },

  // Chrome for a folder view: folder meta, breadcrumb trail, and subfolders.
  // Pass null for the root level.
  listContents(folderId: string | null): Promise<{ data: FolderContents }> {
    return client.get(`/folders/${folderId ?? 'root'}/contents`).then((r) => r.data)
  },

  create(payload: FolderCreate): Promise<{ data: Folder }> {
    return client.post('/folders', payload).then((r) => r.data)
  },

  update(id: string, payload: FolderUpdate): Promise<{ data: Folder }> {
    return client.put(`/folders/${id}`, payload).then((r) => r.data)
  },

  moveFolder(id: string, parentId: string | null): Promise<{ data: Folder }> {
    return client.put(`/folders/${id}`, { parent_folder_id: parentId }).then((r) => r.data)
  },

  delete(id: string): Promise<void> {
    return client.delete(`/folders/${id}`).then(() => undefined)
  },

  // Move a folder (with its contents) into the Archive Bin instead of deleting it.
  archive(id: string): Promise<{ data: Folder }> {
    return client.post(`/folders/${id}/archive`).then((r) => r.data)
  },

  // Permanently delete a folder and everything nested inside it (used from the Bin).
  deleteRecursive(id: string): Promise<void> {
    return client.delete(`/folders/${id}`, { params: { recursive: true } }).then(() => undefined)
  },

  // Permanently delete everything inside the Archive Bin, keeping the Bin itself.
  emptyArchive(): Promise<void> {
    return client.post('/folders/archive/empty').then(() => undefined)
  },
}
