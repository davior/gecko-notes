import { create } from 'zustand'
import { gamApi, isGamNotFound, gamErrorMessage, type GamAsset } from '@/api/gam'

// GAM signs its file addresses for an hour. Re-asking ten minutes early means a block
// that has been on screen a while never hands the player an address about to expire.
export const GAM_URL_TTL_MS = 50 * 60 * 1000

export type GamEntry =
  | { state: 'loading' }
  | { state: 'ready'; asset: GamAsset; fetchedAt: number }
  | { state: 'missing' }
  | { state: 'error'; message: string }

interface GamState {
  /** null until asked; asked once per session (and again after reset). */
  enabled: boolean | null
  publicUrl: string | null
  entries: Record<string, GamEntry>
  loadStatus: () => Promise<void>
  /** A fresh asset for a block, from cache while its addresses are still good. */
  resolve: (assetId: string, opts?: { force?: boolean }) => Promise<GamEntry>
  reset: () => void
}

// Bumped by reset(), so a request started before logout cannot write into the next
// person's store when it lands.
let generation = 0
const inFlight = new Map<string, Promise<GamEntry>>()

export const useGamStore = create<GamState>((set, get) => ({
  enabled: null,
  publicUrl: null,
  entries: {},

  async loadStatus() {
    const gen = generation
    try {
      const response = await gamApi.status()
      if (gen !== generation) return
      set({ enabled: response.data.enabled, publicUrl: response.data.public_url })
    } catch {
      // A Notes backend from before this feature has no such route: no GAM, quietly.
      if (gen !== generation) return
      set({ enabled: false, publicUrl: null })
    }
  },

  resolve(assetId, opts) {
    const cached = get().entries[assetId]
    if (!opts?.force && cached?.state === 'ready' && Date.now() - cached.fetchedAt < GAM_URL_TTL_MS) {
      return Promise.resolve(cached)
    }
    if (!opts?.force && cached?.state === 'missing') return Promise.resolve(cached)
    const pending = inFlight.get(assetId)
    if (pending) return pending

    const gen = generation
    // Keep showing a ready asset while it refreshes, so the image does not blink out.
    if (cached?.state !== 'ready') {
      set((s) => ({ entries: { ...s.entries, [assetId]: { state: 'loading' } } }))
    }
    const request = gamApi
      .getAsset(assetId)
      .then((r): GamEntry => ({ state: 'ready', asset: r.data, fetchedAt: Date.now() }))
      .catch((err): GamEntry => (isGamNotFound(err) ? { state: 'missing' } : { state: 'error', message: gamErrorMessage(err) }))
      .then((entry) => {
        inFlight.delete(assetId)
        if (gen === generation) set((s) => ({ entries: { ...s.entries, [assetId]: entry } }))
        return entry
      })
    inFlight.set(assetId, request)
    return request
  },

  reset() {
    generation += 1
    inFlight.clear()
    set({ enabled: null, publicUrl: null, entries: {} })
  },
}))
