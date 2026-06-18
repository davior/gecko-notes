// Thin, safe wrapper around the Umami analytics script loaded in index.html.
// Custom events sent here surface in the Gecko Notes dashboard (stats.geckopico.com).

declare global {
  interface Window {
    umami?: { track: (event: string, data?: Record<string, unknown>) => void }
  }
}

export function trackEvent(event: string, data?: Record<string, unknown>): void {
  try {
    window.umami?.track(event, data)
  } catch {
    /* analytics must never break the UI */
  }
}

export {}
