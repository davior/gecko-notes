import { create } from 'zustand'
import { foldersApi, type Folder, type FolderCreate, type FolderUpdate } from '@/api/folders'
import { notesApi } from '@/api/notes'

interface FoldersState {
  // Current folder view chrome
  currentFolderId: string | null
  folder: Folder | null
  breadcrumb: Folder[]
  subfolders: Folder[]
  loading: boolean

  loadContents: (folderId: string | null) => Promise<void>
  createFolder: (payload: FolderCreate) => Promise<Folder>
  updateFolder: (id: string, payload: FolderUpdate) => Promise<Folder>
  deleteFolder: (id: string) => Promise<void>
  moveFolder: (id: string, parentId: string | null) => Promise<Folder>
  moveNoteToFolder: (noteId: string, folderId: string | null) => Promise<void>
}

export const useFoldersStore = create<FoldersState>((set, get) => ({
  currentFolderId: null,
  folder: null,
  breadcrumb: [],
  subfolders: [],
  loading: false,

  async loadContents(folderId) {
    set({ loading: true, currentFolderId: folderId })
    try {
      const response = await foldersApi.listContents(folderId)
      set({
        folder: response.data.folder,
        breadcrumb: response.data.breadcrumb,
        subfolders: response.data.subfolders,
      })
    } finally {
      set({ loading: false })
    }
  },

  async createFolder(payload) {
    const response = await foldersApi.create(payload)
    // If the new folder belongs to the current view, show it immediately.
    if ((payload.parent_folder_id ?? null) === get().currentFolderId) {
      set((s) => ({ subfolders: [...s.subfolders, response.data] }))
    }
    return response.data
  },

  async updateFolder(id, payload) {
    const response = await foldersApi.update(id, payload)
    set((s) => ({
      subfolders: s.subfolders.map((f) => (f.id === id ? response.data : f)),
      folder: s.folder?.id === id ? response.data : s.folder,
      breadcrumb: s.breadcrumb.map((f) => (f.id === id ? response.data : f)),
    }))
    return response.data
  },

  async deleteFolder(id) {
    await foldersApi.delete(id)
    set((s) => ({ subfolders: s.subfolders.filter((f) => f.id !== id) }))
  },

  async moveFolder(id, parentId) {
    const response = await foldersApi.moveFolder(id, parentId)
    // The folder left the current view if it was reparented elsewhere.
    if (parentId !== get().currentFolderId) {
      set((s) => ({ subfolders: s.subfolders.filter((f) => f.id !== id) }))
    }
    return response.data
  },

  async moveNoteToFolder(noteId, folderId) {
    await notesApi.move(noteId, folderId)
  },
}))
