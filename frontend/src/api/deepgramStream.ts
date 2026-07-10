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

  // MediaRecorder starts producing chunks immediately, but the WS handshake can
  // take seconds over a real network (DNS + TLS + proxy hops) versus ~50ms on
  // localhost. Dropping not-yet-open chunks silently discards the very first
  // one — the only chunk carrying the WebM/Ogg container header — leaving
  // Deepgram with an undecodable mid-stream fragment stream: it reports 0.0s
  // of audio and closes after ~8s. (This was the production-only "Dictation
  // connection was lost" bug.) Buffer while CONNECTING and flush on open so
  // the header always arrives first.
  const pendingChunks: Blob[] = []
  let stopRequested = false

  ws.onopen = () => {
    for (const chunk of pendingChunks) ws.send(chunk)
    pendingChunks.length = 0
    if (stopRequested) ws.send(JSON.stringify({ type: 'stop' }))
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
    onClose(event.code, CLOSE_CODE_MESSAGES[event.code] ?? event.reason ?? '')
  }

  return {
    sendAudioChunk(chunk: Blob) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk)
      } else if (ws.readyState === WebSocket.CONNECTING) {
        pendingChunks.push(chunk)
      }
    },
    stop() {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stop' }))
      } else if (ws.readyState === WebSocket.CONNECTING) {
        // User released the mic before the handshake finished — flush the
        // buffered audio on open, then stop, so short dictations still land.
        stopRequested = true
      }
    },
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
    },
  }
}
