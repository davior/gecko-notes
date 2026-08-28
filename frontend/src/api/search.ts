import client from './client'

// Web search for the AI assistant. Anthropic models search inside the model call
// (Anthropic's own server-side tool); every other provider has no such tool, so the
// assistant emits a `web_search` plan action and the app runs it through here — see
// backend/app/web_search.py for the configurable backends.

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
  published?: string
}

export interface WebSearchResponse {
  provider: string
  provider_label: string
  query: string
  results: WebSearchResult[]
}

export const searchApi = {
  // `count` is a hint: the server clamps it (1–10) whatever the model asks for.
  // `signal` lets the chat panel's Stop button cut a search short, the same way it
  // aborts a streaming completion.
  web(query: string, count?: number, signal?: AbortSignal): Promise<WebSearchResponse> {
    return client.post('/search/web', { query, count }, { signal }).then((r) => r.data)
  },
}
