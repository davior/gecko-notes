import client from './client'
import type { NoteAsset } from './assets'

export type GamAssetType = 'image' | 'video' | 'audio' | 'document'

/**
 * One asset in the person's GAM library, as Notes' backend hands it over.
 *
 * `file_url` and `thumb_url` are GAM's signed addresses and expire after an hour, which
 * is why a note never stores them: the `gamAsset` block keeps only the id and asks
 * again (see `useGamStore.resolve`).
 */
export interface GamAsset {
  id: string
  name: string
  asset_type: GamAssetType
  description: string | null
  original_name: string | null
  mime_type: string | null
  file_format: string | null
  size_bytes: number
  duration_seconds: number | null
  width: number | null
  height: number | null
  /** A clip is a window on its parent's file; play only this stretch of it. */
  in_point: number | null
  out_point: number | null
  file_url: string | null
  thumb_url: string | null
  /** The asset's own page in GAM. Stable, unlike the file addresses. */
  page_url: string
  credit: string
  missing: boolean
}

export interface GamHit {
  asset: GamAsset
  /** The matched words, with «guillemets» around them for a keyword hit. */
  snippet: string
  page_label: string | null
  start_time: number | null
}

export interface GamStatus {
  enabled: boolean
  public_url: string | null
}

export interface GamSearchResult {
  data: GamHit[]
  total: number
  query: string
  /** False when GAM ran only its keyword half, so "no results" means less. */
  semantic: boolean
}

export const gamApi = {
  status(): Promise<{ data: GamStatus }> {
    return client.get('/gam/status').then((r) => r.data)
  },

  /** With no query, GAM's newest assets, so the picker shows something before typing. */
  search(q: string, assetType?: GamAssetType | null, limit = 30): Promise<GamSearchResult> {
    return client
      .get('/gam/search', { params: { q, asset_type: assetType || undefined, limit } })
      .then((r) => r.data)
  },

  getAsset(assetId: string): Promise<{ data: GamAsset }> {
    return client.get(`/gam/assets/${encodeURIComponent(assetId)}`).then((r) => r.data)
  },

  /** Copy the GAM file into this note's own media, for shared notes, exports and offline. */
  copyIntoNote(noteId: string, assetId: string, origin?: string): Promise<{ data: NoteAsset }> {
    return client
      .post(`/notes/${noteId}/assets/from-gam`, { asset_id: assetId, origin })
      .then((r) => r.data)
  },
}

/** The server's sentence for a failure, or a fallback that still says what failed. */
export function gamErrorMessage(err: unknown, fallback = 'The asset library could not be reached.'): string {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
  if (detail && typeof detail === 'object' && 'message' in detail) {
    return String((detail as { message: unknown }).message)
  }
  return fallback
}

/** Whether a failure means the asset is gone (or not this person's), not GAM being down. */
export function isGamNotFound(err: unknown): boolean {
  return (err as { response?: { status?: number } })?.response?.status === 404
}
