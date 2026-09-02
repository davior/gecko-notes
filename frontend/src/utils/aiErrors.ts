/**
 * Turning an AI-proxy failure into one readable line.
 *
 * The two proxy paths disagree about where the upstream body ends up, and that is
 * the whole reason this exists as a tested module rather than a helper inside the
 * panel:
 *
 *   blocking   `HTTPException(detail=response.text)`  ->  response.data.detail
 *   streaming  an SSE `error` frame, and `_error_frame` wraps a string detail as
 *              `{"message": ...}`                     ->  response.data.message
 *
 * `api/stream.ts` says it throws axios-shaped errors "so the chat panel's
 * errorMessage()/formatErrorDetails() render streaming failures identically". They
 * did not: only `detail` was unwrapped, so a streaming failure — which is the normal
 * chat path — showed the provider's raw envelope. A transient upstream hiccup then
 * reads like the app crashed.
 */

/** Providers' names for "busy, try again", plus the HTTP statuses that mean it. */
const TRANSIENT_CODES = new Set([
  'service_unavailable_error',
  'overloaded_error',
  'rate_limit_error',
  'server_error',
])
// Only the statuses that mean it on their own. Deliberately not 502: our own proxy
// raises that for anything upstream returned non-2xx, including a missing API key —
// and telling someone to retry a configuration error is worse than saying nothing.
const TRANSIENT_STATUSES = new Set([429, 503])

const TRANSIENT_HINT = 'The AI provider is busy right now — try again in a moment.'

interface ProviderEnvelope {
  error?: { message?: unknown; type?: unknown; code?: unknown }
  message?: unknown
  code?: unknown
}

/** Lift the human-readable string out of a provider's error envelope. */
function unwrap(raw: unknown): { text?: string; code?: string } {
  if (typeof raw === 'string') {
    let parsed: ProviderEnvelope
    try {
      parsed = JSON.parse(raw) as ProviderEnvelope
    } catch {
      return { text: raw } // not JSON — it is already the message
    }
    return unwrap(parsed)
  }
  if (!raw || typeof raw !== 'object') return {}

  const envelope = raw as ProviderEnvelope
  // OpenAI-compatible and Anthropic both nest under `error`; our own HTTPException
  // details are flat.
  const inner = (envelope.error ?? envelope) as { message?: unknown; type?: unknown; code?: unknown }
  const nested = typeof inner.message === 'string' ? unwrap(inner.message) : {}

  return {
    text: nested.text ?? (typeof inner.message === 'string' ? inner.message : undefined),
    code:
      nested.code ??
      (typeof inner.type === 'string' ? inner.type : undefined) ??
      (typeof inner.code === 'string' ? inner.code : undefined),
  }
}

/**
 * Short, human-readable error line for the chat. The full body still goes to the
 * collapsible "More details" panel — this is only the headline.
 */
export function errorMessage(e: unknown, fallback = 'An error occurred'): string {
  const ax = e as {
    message?: string
    response?: { status?: number; data?: { detail?: unknown; message?: unknown } }
  }
  const data = ax.response?.data

  // `detail` (blocking) or `message` (streaming SSE frame) — whichever this path used.
  const payload = data?.detail ?? data?.message ?? (e instanceof Error ? e.message : undefined)
  const { text, code } = unwrap(payload)

  const message = text || (e instanceof Error ? e.message : '') || fallback
  const transient =
    (code && TRANSIENT_CODES.has(code)) || TRANSIENT_STATUSES.has(ax.response?.status ?? 0)

  // "Server Overloaded" on its own does not tell the user it is the provider's, and
  // theirs to retry.
  return transient && !message.includes(TRANSIENT_HINT) ? `${message} — ${TRANSIENT_HINT}` : message
}
