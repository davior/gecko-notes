// WebSocket client for realtime Deepgram dictation, proxied through our backend
// (browser <-> backend <-> Deepgram) so the Deepgram API key never reaches the
// client. Modeled on api/stream.ts's manual-auth-attachment approach: a native
// WebSocket can't set an Authorization header, so the JWT travels as a query
// param instead (the backend route expects exactly this — see
// backend/app/routers/stt_stream.py `_get_ws_user_id`).

export type DeepgramStreamEvent =
  | { type: 'interim'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; message: string }

export interface DeepgramStreamHandle {
  /** Forward one MediaRecorder chunk to Deepgram as a binary frame. */
  sendAudioChunk: (chunk: Blob) => void
  /** Graceful stop: tells the backend to flush Deepgram's trailing final results
   *  before closing. Use this when the user releases the mic button. */
  stop: () => void
  /** Hard close, no flush — used for unmount/cleanup. */
  close: () => void
}

const CLOSE_CODE_MESSAGES: Record<number, string> = {
  4400: 'Deepgram API key not configured — set one in Settings → AI Services → Speech',
  4401: 'Not authenticated',
  4409: 'A Deepgram dictation session is already active',
}

function wsBaseURL(): string {
  const apiBase = import.meta.env.VITE_API_BASE_URL || '/api'
  const absolute = new URL(apiBase, window.location.href)
  absolute.protocol = absolute.protocol === 'https:' ? 'wss:' : 'ws:'
  return absolute.toString().replace(/\/$/, '')
}

export function connectDeepgramStream(
  onEvent: (event: DeepgramStreamEvent) => void,
  onClose: (code: number, reason: string) => void,
): DeepgramStreamHandle {
  const token = localStorage.getItem('auth_token') ?? ''
  const url = `${wsBaseURL()}/stt-stream/ws?token=${encodeURIComponent(token)}`
  const ws = new WebSocket(url)
  const openedAt = performance.now()
  let chunksSent = 0

  // Temporary diagnostics for a production-only dictation drop — remove once
  // root-caused. Backend-side logging alone couldn't explain a clean-looking
  // disconnect with no exception, so this gives us the browser's own view of
  // timing/close code to compare against the backend logs for the same session.
  ws.onopen = () => {
    // eslint-disable-next-line no-console
    console.log('[deepgram] ws open')
  }

  ws.onerror = (event) => {
    // eslint-disable-next-line no-console
    console.warn('[deepgram] ws error', event, `after ${(performance.now() - openedAt).toFixed(0)}ms, ${chunksSent} chunk(s) sent`)
  }

  ws.onmessage = (event) => {
    if (typeof event.data !== 'string') return
    try {
      const parsed = JSON.parse(event.data) as DeepgramStreamEvent
      onEvent(parsed)
    } catch {
      // ignore malformed frames
    }
  }

  ws.onclose = (event) => {
    // eslint-disable-next-line no-console
    console.log(
      '[deepgram] ws closed',
      { code: event.code, reason: event.reason, wasClean: event.wasClean },
      `after ${(performance.now() - openedAt).toFixed(0)}ms, ${chunksSent} chunk(s) sent`,
    )
    onClose(event.code, CLOSE_CODE_MESSAGES[event.code] ?? event.reason ?? '')
  }

  return {
    sendAudioChunk(chunk: Blob) {
      if (ws.readyState === WebSocket.OPEN) {
        chunksSent += 1
        ws.send(chunk)
      }
    },
    stop() {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' }))
    },
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
    },
  }
}
