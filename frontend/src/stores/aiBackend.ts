import { create } from 'zustand'
import { settingsApi, type AiBackendInfo } from '@/api/settings'

/**
 * Whether AI runs through Gecko Suite, and where to reach it.
 *
 * Read once per session: it is a deployment setting, so it cannot change under a signed-in
 * person. A failed read leaves it `null`, which every caller treats as "local": a settings
 * page must not claim the suite holds the keys on the strength of an error.
 */
interface AiBackendState {
  info: AiBackendInfo | null
  load: () => Promise<void>
  reset: () => void
}

// Bumped by reset(), so a read that began before a sign-out cannot land in the next session.
let generation = 0

export const useAiBackendStore = create<AiBackendState>((set, get) => ({
  info: null,

  async load() {
    if (get().info) return
    const mine = generation
    try {
      const info = await settingsApi.getAiBackend()
      if (mine === generation) set({ info })
    } catch {
      // Stay null: shown as local.
    }
  },

  reset() {
    generation += 1
    set({ info: null })
  },
}))
