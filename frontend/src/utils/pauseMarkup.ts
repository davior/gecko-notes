// Configurable pause insertion for the note "read aloud" feature.
//
// Deepgram (both Flux, used today, and Aura-2) has no SSML support — a
// `<break>`/`<prosody>` tag sent as text would just be read aloud or dropped,
// not honoured as a pause. So pauses here are made real the same way the
// player already works: text is split into separate TTS requests
// (`useTextToSpeech`'s chunk queue) and a real silence gap is held between
// them during playback, rather than emitted as markup.
//
// This mirrors `backend/app/video/pause_markup.py` (used by the
// article-to-video narration pipeline) so the same `[pause:...]` syntax and
// punctuation rules work whether a note is read aloud in the editor or
// rendered into a video. Keep the two in sync if the rules change.

export interface SpeechChunk {
  text: string
  pauseAfterMs: number
}

// Implicit pause after each trigger, in milliseconds. `\n\n` is the pause for
// *one* blank line; each additional blank line multiplies it. Single source
// of truth for this feature on the frontend — no duration is hardcoded
// elsewhere.
export const DEFAULT_PAUSE_MS: Record<string, number> = { '.': 900, '…': 1300, '\n\n': 1600 }

// Named levels for the `[pause:short|medium|long|xlong]` marker.
export const NAMED_PAUSE_MS: Record<string, number> = { short: 350, medium: 750, long: 1200, xlong: 2000 }

const MARKER_SRC = String.raw`\[pause:(?<mval>[A-Za-z]+|\d+)\]`
const PARA_BREAK_SRC = String.raw`\n[ \t]*\n+`
const TRIGGER_SRC = String.raw`\.\.\.|…|\.`
const EVENT_RE = new RegExp(`(?:${MARKER_SRC})|(?<para>${PARA_BREAK_SRC})|(?<trig>${TRIGGER_SRC})`, 'g')
const LOOKAHEAD_MARKER_RE = new RegExp(`^[ \\t]*${MARKER_SRC}`)

function resolveMarker(value: string, namedPauseMs: Record<string, number>): number {
  if (/^\d+$/.test(value)) return parseInt(value, 10)
  const ms = namedPauseMs[value.toLowerCase()]
  return ms ?? 0 // an unknown level is treated as "no pause" rather than throwing mid-playback
}

/**
 * Split narration into `SpeechChunk`s at sentence/paragraph/marker boundaries.
 *
 * Implicit pauses come from `pauseMs` — `.`/`...`/`…` end a sentence, `\n\n`
 * (a blank line) ends a paragraph, with each additional blank line
 * multiplying that pause. Explicit `[pause:1200]` / `[pause:LEVEL]` markers
 * are always stripped from the output text; one directly following (only
 * whitespace between) an implicit trigger overrides that trigger's pause
 * instead of adding to it. A marker anywhere else just becomes its own chunk
 * boundary.
 *
 * Two boundaries with no words between them (e.g. a sentence-ending period
 * immediately followed by a blank line) don't produce an empty chunk — the
 * longer of the two pauses is kept on the previous chunk instead.
 *
 * The final chunk always carries `pauseAfterMs === 0` — there is nothing
 * after it to hold a gap before.
 */
export function parsePauseMarkup(
  text: string,
  pauseMs: Record<string, number> = DEFAULT_PAUSE_MS,
  namedPauseMs: Record<string, number> = NAMED_PAUSE_MS,
): SpeechChunk[] {
  const body = text || ''
  const chunks: SpeechChunk[] = []
  let current: string[] = []

  const emit = (ms: number) => {
    const segment = current.join('').trim()
    current = []
    if (segment) {
      chunks.push({ text: segment, pauseAfterMs: ms })
    } else if (chunks.length > 0) {
      const last = chunks[chunks.length - 1]
      chunks[chunks.length - 1] = { text: last.text, pauseAfterMs: Math.max(last.pauseAfterMs, ms) }
    }
    // A pause before any spoken text has nothing to attach to — dropped.
  }

  let pos = 0
  EVENT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = EVENT_RE.exec(body)) !== null) {
    if (m.index < pos) continue // already consumed as an override lookahead below
    const gap = body.slice(pos, m.index)
    const groups = m.groups ?? {}
    const mval = groups.mval

    if (mval !== undefined) {
      current.push(gap)
      pos = m.index + m[0].length
      emit(resolveMarker(mval, namedPauseMs))
      continue
    }

    current.push(gap)
    let ms: number
    if (groups.para !== undefined) {
      const blankLines = (groups.para.match(/\n/g) ?? []).length - 1
      ms = pauseMs['\n\n'] * Math.max(1, blankLines)
    } else {
      const trigText = groups.trig as string
      const key = trigText === '.' ? '.' : '…'
      current.push(trigText)
      ms = pauseMs[key]
    }
    pos = m.index + m[0].length

    const override = LOOKAHEAD_MARKER_RE.exec(body.slice(pos))
    if (override?.groups?.mval !== undefined) {
      ms = resolveMarker(override.groups.mval, namedPauseMs)
      pos += override[0].length
    }

    emit(ms)
  }

  current.push(body.slice(pos))
  const tail = current.join('').trim()
  if (tail) {
    chunks.push({ text: tail, pauseAfterMs: 0 })
  } else if (chunks.length > 0) {
    const last = chunks[chunks.length - 1]
    chunks[chunks.length - 1] = { text: last.text, pauseAfterMs: 0 }
  }

  return chunks
}
