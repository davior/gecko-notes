import { create } from 'zustand'
import {
  assetsApi,
  assetErrorMessage,
  type NoteAsset,
  type NoteAssetUpdate,
} from '@/api/assets'

/**
 * Cache of the open note's assets.
 *
 * A store rather than props because the two things that invalidate it — a file dropped
 * into the editor, and a note save — happen inside EditorView's `uploadFile` and
 * `doSave`, a long way from the panel that renders the list. Passing a refresh key down
 * would re-render the whole editor view for what is really a side-channel notification.
 *
 * `watching` is set only while the Assets tab is on screen, so `invalidate()` costs
 * nothing during ordinary typing: the editor autosaves every 800ms and must not fire a
 * request each time.
 */
interface AssetsState {
  /** Which note the cache holds, so a stale note's assets are never shown. */
  noteId: string | null
  assets: NoteAsset[]
  loading: boolean
  error: string | null
  watching: boolean

  load: (noteId: string, force?: boolean) => Promise<void>
  invalidate: (noteId: string | null | undefined) => void
  setWatching: (on: boolean) => void
  /** Fetch for the assistant's context, whether or not the tab is open. */
  loadForContext: (noteId: string) => Promise<NoteAsset[]>
  upload: (noteId: string, file: File) => Promise<NoteAsset>
  update: (noteId: string, assetId: string, payload: NoteAssetUpdate) => Promise<NoteAsset>
  remove: (noteId: string, assetId: string) => Promise<void>
  reset: () => void
}

export const useAssetsStore = create<AssetsState>((set, get) => ({
  noteId: null,
  assets: [],
  loading: false,
  error: null,
  watching: false,

  async load(noteId, force = false) {
    const state = get()
    if (state.loading && state.noteId === noteId && !force) return
    set({ loading: true, error: null, noteId })
    try {
      const response = await assetsApi.list(noteId)
      // Guard against a slow response for a note the user has already navigated away
      // from overwriting the one they are looking at now.
      if (get().noteId !== noteId) return
      set({ assets: response.data })
    } catch (e) {
      if (get().noteId !== noteId) return
      set({ error: assetErrorMessage(e, 'Could not load assets') })
    } finally {
      if (get().noteId === noteId) set({ loading: false })
    }
  },

  invalidate(noteId) {
    const state = get()
    if (!noteId || !state.watching || state.noteId !== noteId) return
    void state.load(noteId, true)
  },

  setWatching(on) {
    set({ watching: on })
  },

  async loadForContext(noteId) {
    const state = get()
    if (state.noteId === noteId && state.assets.length) return state.assets
    const response = await assetsApi.list(noteId)
    if (get().noteId === noteId || !get().noteId) {
      set({ noteId, assets: response.data })
    }
    return response.data
  },

  async upload(noteId, file) {
    const response = await assetsApi.upload(noteId, file)
    set((s) => (s.noteId === noteId ? { assets: [response.data, ...s.assets] } : {}))
    return response.data
  },

  async update(noteId, assetId, payload) {
    const response = await assetsApi.update(noteId, assetId, payload)
    set((s) => ({ assets: s.assets.map((a) => (a.id === assetId ? response.data : a)) }))
    return response.data
  },

  async remove(noteId, assetId) {
    await assetsApi.remove(noteId, assetId)
    set((s) => ({ assets: s.assets.filter((a) => a.id !== assetId) }))
  },

  reset() {
    set({ noteId: null, assets: [], loading: false, error: null, watching: false })
  },
}))
