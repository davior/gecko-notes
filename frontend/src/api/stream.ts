// Fetch-based SSE client for the streaming AI proxy endpoints. Browser axios buffers
// the whole response body, so it can't surface tokens as they arrive; this uses
// fetch + a ReadableStream reader instead. Because it bypasses the shared axios
// `client`, it must replicate that client's auth header and 401→login behaviour
// (see api/client.ts), and it throws axios-shaped errors so the chat panel's
// errorMessage()/formatErrorDetails() render streaming failures identically.

const baseURL = import.meta.env.VITE_API_BASE_URL || '/api'

// Error carrying an axios-like `.response` so existing error rendering works unchanged.
export interface StreamError extends Error {
  response?: { status: number; statusText: string; data: unknown }
}

function makeError(message: string, status: number, statusText: string, data: unknown): StreamError {
  const err = new Error(message) as StreamError
  err.response = { status, statusText, data }
  return err
}

// POST `body` to a streaming proxy endpoint, invoking `onDelta` with each text chunk
// as it arrives, and resolving with the `final` provider dict (same shape the blocking
// endpoint returns) so callers reuse their existing response extraction.
export async function streamChat(
  path: string,
  body: unknown,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<unknown> {
  const token = localStorage.getItem('auth_token')
  const res = await fetch(baseURL + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok) {
    // Mirror client.ts: on 401 (non-auth endpoint) clear creds and bounce to login.
    if (res.status === 401 && !path.includes('/auth/')) {
      localStorage.removeItem('auth_token')
      localStorage.removeItem('auth_user')
      window.location.href = '/login'
    }
    const raw = await res.text().catch(() => '')
    let data: unknown = raw
    try { data = raw ? JSON.parse(raw) : undefined } catch { /* keep raw text */ }
    throw makeError(`Request failed with status ${res.status}`, res.status, res.statusText, data)
  }
  if (!res.body) throw new Error('Streaming is not supported in this environment')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let final: unknown

  // One SSE frame = `event:`/`data:` lines separated from the next frame by a blank line.
  const handleFrame = (frame: string) => {
    let event = 'message'
    const dataLines: string[] = []
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    if (!dataLines.length) return
    let payload: { text?: unknown; message?: unknown } | undefined
    try { payload = JSON.parse(dataLines.join('\n')) } catch { return }
    if (event === 'delta') {
      if (payload && typeof payload.text === 'string') onDelta(payload.text)
    } else if (event === 'final') {
      final = payload
    } else if (event === 'error') {
      const message = payload && typeof payload.message === 'string' ? payload.message : 'Stream error'
      throw makeError(message, 502, 'Bad Gateway', payload)
    }
  }

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        handleFrame(frame)
      }
    }
    if (buf.trim()) handleFrame(buf)
  } finally {
    // Close the connection if we bailed early (error frame / abort).
    reader.cancel().catch(() => {})
  }

  if (final === undefined) throw new Error('Stream ended without a final message')
  return final
}
