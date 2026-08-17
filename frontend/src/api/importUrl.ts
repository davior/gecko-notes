import client from './client'

export interface UrlExtractResult {
  /** Final URL, after redirects. */
  url: string
  title: string
  /** Author, when the page declares one. */
  byline?: string | null
  /** ISO date, when the page declares one. */
  published?: string | null
  site_name?: string | null
  /** Meta description — becomes the note summary. */
  excerpt?: string | null
  /** Bare domain — becomes the note's tag. */
  hostname: string
  /** Main content; links and images are already absolute. */
  markdown: string
  /** Unique http(s) images referenced by the markdown. */
  image_urls: string[]
}

export interface ResourceFetchResult {
  /** Remote URL -> stored /media/... URL. Missing keys were not downloaded. */
  mapping: Record<string, string>
  failed: string[]
}

export const importUrlApi = {
  // Fetch a page and extract its main content as Markdown. Reads only — nothing is
  // stored until fetchResources runs, so previewing an import is free to cancel.
  extract(url: string): Promise<UrlExtractResult> {
    return client.post('/import/url/extract', { url }).then((r) => r.data.data)
  },

  // Download images into the user's media library. `pageUrl` is sent as the Referer,
  // which hotlink-protected CDNs require.
  fetchResources(urls: string[], pageUrl: string): Promise<ResourceFetchResult> {
    return client
      .post('/import/url/resources', { urls, page_url: pageUrl })
      .then((r) => r.data.data)
  },
}

// Axios error -> the backend's {code, message} detail, falling back to a usable string.
export function importErrorMessage(e: unknown, fallback: string): string {
  const ax = e as { response?: { data?: { detail?: { message?: string } | string } } }
  const detail = ax.response?.data?.detail
  if (detail && typeof detail === 'object' && detail.message) return detail.message
  if (typeof detail === 'string') return detail
  return fallback
}
