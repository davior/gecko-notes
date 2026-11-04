/**
 * Where the stream goes (SN-9). With AI through Gecko Suite, the suite's live dictation
 * (`/api/v1/ai/speech/stt/stream`), which relays to Deepgram with the suite's key in this
 * same protocol and counts the minutes under Notes; otherwise Notes' own relay, as before.
 * Pure, so it can be tested without a browser.
 */
export function streamUrl(
  suiteUrl: string | null,
  token: string,
  model: string,
  ownBase: string,
): string {
  if (suiteUrl) {
    const ws = suiteUrl.replace(/\/+$/, '').replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
    const params = new URLSearchParams({ app: 'notes', token })
    if (model) params.set('model', model)
    return `${ws}/api/v1/ai/speech/stt/stream?${params.toString()}`
  }
  return `${ownBase}/stt-stream/ws?token=${encodeURIComponent(token)}`
}
