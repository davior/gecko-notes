// WebSocket client for Deepgram Flux voice mode, proxied through our backend
// (browser <-> backend <-> Deepgram Flux) so the Deepgram key never reaches the
// client. Modeled on api/deepgramStream.ts: a native WebSocket can't set an
// Authorization header, so the JWT travels as a query param (the backend route
// expects exactly this — see backend/app/routers/flux_stream.py `_get_ws_user_id`).
//
// Flux is a *conversational* STT model: instead of interim/final transcripts it
// emits discrete turn events that drive the hands-free loop.

export type FluxStreamEvent =
  | { type: 'start_of_turn' }
  | { type: 'update'; text: string }
  | { type: 'eager_eot'; text: string }
  | { type: 'end_of_turn'; text: string; turn_index?: number }
  | { type: 'turn_resumed' }
  | { type: 'error'; message: string }

export interface FluxStreamHandle {
  /** Forward one MediaRecorder chunk to Flux as a binary frame. */
  sendAudioChunk: (chunk: Blob) => void
  /** Graceful stop: asks the backend to close the Flux stream. */
  stop: () => void
  /** Hard close, no flush — used for unmount/cleanup. */
  close: () => void
}

export const FLUX_CLOSE_CODE_MESSAGES: Record<number, string> = {
  4400: 'Deepgram API key not configured — set one in Settings → AI Services → Speech',
  4401: 'Not authenticated',
  4403: 'Voice mode is disabled for this instance',
  4409: 'A voice session is already active',
}

function wsBaseURL(): string {
  const apiBase = import.meta.env.VITE_API_BASE_URL || '/api'
  const absolute = new URL(apiBase, window.location.href)
  absolute.protocol = absolute.protocol === 'https:' ? 'wss:' : 'ws:'
  return absolute.toString().replace(/\/$/, '')
}

export function connectFluxStream(
  onEvent: (event: FluxStreamEvent) => void,
  onClose: (code: number, reason: string) => void,
): FluxStreamHandle {
  const token = localStorage.getItem('auth_token') ?? ''
  const url = `${wsBaseURL()}/flux-stream/ws?token=${encodeURIComponent(token)}`
  const ws = new WebSocket(url)

  // Same header-chunk race as dictation: MediaRecorder emits chunks immediately,
  // but the WS handshake can take seconds over a real network. Dropping the very
  // first chunk (the only one carrying the WebM/Ogg container header) leaves the
  // decoder with an undecodable mid-stream fragment. Buffer while CONNECTING and
  // flush on open so the header always arrives first.
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
      onEvent(JSON.parse(event.data) as FluxStreamEvent)
    } catch {
      // ignore malformed frames
    }
  }

  ws.onclose = (event) => {
    onClose(event.code, FLUX_CLOSE_CODE_MESSAGES[event.code] ?? event.reason ?? '')
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
        stopRequested = true
      }
    },
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
    },
  }
}
