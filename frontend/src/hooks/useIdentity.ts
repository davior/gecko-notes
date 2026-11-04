import { useEffect, useState } from 'react'
import { configApi } from '@/api/config'

/**
 * Who signs people in, from `/api/config` (M6).
 *
 * `null` until it has arrived, so a page can hold back a form it might not need rather
 * than flash it. Fetched once per tab: the setting changes only with a redeploy. A failed
 * fetch counts as Notes, the default, so a backend hiccup never hides the login form.
 */
export interface Identity {
  provider: 'notes' | 'suite'
  url: string | null
}

let cached: Promise<Identity> | null = null

export function loadIdentity(): Promise<Identity> {
  if (!cached) {
    cached = configApi
      .get()
      .then((c) => ({
        provider: c.identity_provider === 'suite' && c.identity_url ? ('suite' as const) : ('notes' as const),
        url: c.identity_url ? c.identity_url.replace(/\/+$/, '') : null,
      }))
      .catch(() => {
        cached = null
        return { provider: 'notes' as const, url: null }
      })
  }
  return cached
}

/** Test seam: the module cache would otherwise leak between tests. */
export function resetIdentity(): void {
  cached = null
}

export function useIdentity(): Identity | null {
  const [identity, setIdentity] = useState<Identity | null>(null)
  useEffect(() => {
    let live = true
    void loadIdentity().then((i) => {
      if (live) setIdentity(i)
    })
    return () => {
      live = false
    }
  }, [])
  return identity
}
