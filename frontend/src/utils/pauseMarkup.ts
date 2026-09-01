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
// rendered into a video. Keep the two in sync if the rules change — they are
// checked against one shared table of cases, `backend/tests/fixtures/
// pause_cases.json`, by `pauseMarkup.test.ts` and `test_pause_markup.py`.

export interface SpeechChunk {
  text: string
  pauseAfterMs: number
}

// Implicit pause after each trigger, in milliseconds. `\n\n` is the pause for
// *one* blank line; each additional blank line multiplies it. Single source
// of truth for this feature on the frontend — no duration is hardcoded
// elsewhere.
//
// These are *added* silence, on top of the gap a chunk boundary already
// creates: every chunk is its own TTS request, so its audio arrives with the
// engine's own trailing fall and leading lead-in, and the player needs a
// moment to swap clips. Read the numbers as "how much longer than an ordinary
// sentence break", not as the length of the gap a listener hears.
//
// Hence the ordinary "." is small. It is the one trigger nobody opts into —
// every sentence in every note ends with one — so it has to sound like prose,
// not like a beat. It sits below even `NAMED_PAUSE_MS.short`, so a writer who
// actually types `[pause:short]` still gets something audibly longer than the
// full stop they'd have got for free. The deliberate marks — an ellipsis, a
// blank line — are where the long pauses belong.
export const DEFAULT_PAUSE_MS: Record<string, number> = { '.': 250, '…': 1300, '\n\n': 1600 }

// Named levels for the `[pause:short|medium|long|xlong]` marker.
export const NAMED_PAUSE_MS: Record<string, number> = { short: 350, medium: 750, long: 1200, xlong: 2000 }

// What a marker means when it names no duration (`[pause]`) or names one that
// isn't in `namedPauseMs` (`[pause:xxlong]`). An unrecognised level resolves
// here rather than throwing or silently becoming a zero-length gap.
export const DEFAULT_MARKER_MS = NAMED_PAUSE_MS.medium

// Ceiling on one explicit marker. A bare number is milliseconds, so somebody
// reaching for seconds and writing `[pause:120000]` would otherwise hold two
// minutes of silence in the middle of playback.
export const MAX_PAUSE_MS = 10_000

// Quote and bracket characters that close a sentence *after* its full stop.
// Both triggers below swallow them so `He said "go." Then left.` keeps the
// closing quote on the chunk it belongs to instead of opening the next one.
const CLOSERS_SRC = String.raw`["'’”)\]]*`
// `[pause]`, `[pause:long]`, `[Pause: 2s]`, `[PAUSE 1500]`, `[pause=400ms]` —
// the separator, the value and the unit are each optional, and the whole thing
// is matched case-insensitively. Only spaces and tabs are allowed inside,
// never a newline: a marker must not be able to swallow the blank line that a
// paragraph break is made of.
const MARKER_SRC = String.raw`(?<marker>\[[ \t]*pause[ \t]*(?:(?:[:=][ \t]*|[ \t]+)(?<mval>[A-Za-z]+|\d+(?:\.\d+)?)[ \t]*(?<munit>ms|seconds|second|secs|sec|s)?[ \t]*)?\])`
const PARA_BREAK_SRC = String.raw`\n[ \t]*\n+`
// Two or more periods, however they're spaced, are one ellipsis. Matching them
// as a single event is what stops "Wait...." leaving a stray "." to open the
// next chunk — which the TTS engine then reads aloud as its own utterance.
const ELLIPSIS_SRC = String.raw`(?:\.(?:[ \t]*\.)+|…)` + CLOSERS_SRC
// A lone period. Never inside a number ("3.5", "$1,200.50"); `endsASentence`
// rules out the rest.
const SENTENCE_END_SRC = String.raw`(?<!\d)\.(?!\d)` + CLOSERS_SRC

const EVENT_RE = new RegExp(
  `(?:${MARKER_SRC})|(?<para>${PARA_BREAK_SRC})|(?<ell>${ELLIPSIS_SRC})|(?<dot>${SENTENCE_END_SRC})`,
  'gi',
)
const LOOKAHEAD_MARKER_RE = new RegExp(String.raw`[ \t]*` + MARKER_SRC, 'iy')
const MARKER_ONLY_RE = new RegExp(MARKER_SRC, 'gi')

// A voice can say letters and digits; punctuation, symbols and emoji on their
// own are not speech. The negated class excludes emoji naturally — they are
// symbol-category, not word characters — while keeping accented, Greek and CJK
// text speakable. (`\w` is ASCII-only in JS, hence the explicit Unicode
// property escapes rather than the `[^\W_]` the Python module can use.)
const SPEAKABLE_RE = /[\p{L}\p{N}]/u

/**
 * Is there anything here a TTS engine could actually pronounce?
 *
 * A chunk of pure punctuation is not a smaller request, it is a broken one: the
 * provider has nothing to synthesise and answers with an empty or non-audio
 * body. In the player that is a chunk of silence where speech should be; in the
 * video renderer the same body reaches ffmpeg as an undecodable file and fails
 * the whole render. So a beat written as "...", a "---" rule, or a paragraph
 * holding nothing but an emoji must never become a request of its own.
 */
export function hasSpeech(text: string): boolean {
  return SPEAKABLE_RE.test(text || '')
}

// Words that end in a period without ending a sentence. Lowercased for lookup.
const ABBREVIATIONS = new Set([
  'dr', 'mr', 'mrs', 'ms', 'prof', 'rev', 'sr', 'jr', 'st', 'mt', 'ft',
  'vs', 'etc', 'al', 'cf', 'approx', 'est', 'dept', 'no', 'fig', 'vol',
  'ch', 'pp', 'inc', 'ltd', 'co', 'corp', 'univ',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct',
  'nov', 'dec',
  'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
])

// Longest abbreviation above, plus room for the word to start mid-slice.
const ABBREV_WINDOW = 32
const WORD_BEFORE_RE = /([A-Za-z]+)$/
const AFTER_DOT_RE = /\s|$/y

type Groups = Record<string, string | undefined>

/**
 * Is the "." at `body[start:end]` a sentence end, or part of a word?
 *
 * A period only ends a sentence when what follows it (past any closing quote
 * or bracket, which `SENTENCE_END_SRC` has already consumed) is whitespace or
 * the end of the text, and what precedes it is neither a single letter — an
 * initial, or one leg of "e.g."/"U.S." — nor a known abbreviation. Without
 * this the player pauses inside "3.5", after "Dr", and three separate times
 * inside "www.example.com".
 */
function endsASentence(body: string, start: number, end: number): boolean {
  AFTER_DOT_RE.lastIndex = end
  if (!AFTER_DOT_RE.test(body)) return false
  const word = WORD_BEFORE_RE.exec(body.slice(Math.max(0, start - ABBREV_WINDOW), start))
  if (word === null) return true
  const token = word[1]
  return token.length > 1 && !ABBREVIATIONS.has(token.toLowerCase())
}

/**
 * Resolve one `[pause:...]` marker to milliseconds.
 *
 * A bare number is milliseconds — `[pause:1500]` is a second and a half — and
 * an `s`/`sec`/`second` suffix opts into seconds instead. A bare *decimal* is
 * read as seconds as well: `[pause:1.5]` can only have meant 1.5 seconds,
 * since a millisecond and a half is far below anything a listener could hear.
 *
 * A marker with no value at all, or with a level this caller doesn't define,
 * falls back to `DEFAULT_MARKER_MS` — a typo must not stall playback on an
 * unbounded timeout, nor silently collapse to no pause at all.
 */
function resolveMarker(
  value: string | undefined,
  unit: string | undefined,
  namedPauseMs: Record<string, number>,
): number {
  if (value === undefined) return DEFAULT_MARKER_MS
  if (!/^\d/.test(value)) return namedPauseMs[value.toLowerCase()] ?? DEFAULT_MARKER_MS

  const amount = parseFloat(value)
  const suffix = (unit ?? '').toLowerCase()
  let milliseconds: number
  if (suffix === 'ms') milliseconds = amount
  else if (suffix || value.includes('.')) milliseconds = amount * 1000
  else milliseconds = amount
  return Math.max(0, Math.min(MAX_PAUSE_MS, Math.round(milliseconds)))
}

/**
 * Remove `[pause:...]` markers from text that is displayed rather than spoken.
 * Mirrors `strip_pause_markup` in the Python module.
 */
export function stripPauseMarkup(text: string): string {
  if (!text) return text
  const cleaned = text.replace(MARKER_ONLY_RE, '').replace(/[ \t]{2,}/g, ' ')
  return cleaned.split('\n').map((line) => line.trim()).join('\n').trim()
}

/**
 * Split narration into `SpeechChunk`s at sentence/paragraph/marker boundaries.
 *
 * Implicit pauses come from `pauseMs` — `.`/`...`/`…` end a sentence, `\n\n`
 * (a blank line) ends a paragraph, with each additional blank line
 * multiplying that pause. Explicit `[pause:1500]` / `[pause:LEVEL]` markers
 * are always stripped from the output text; one directly following (only
 * whitespace between) an implicit trigger overrides that trigger's pause
 * instead of adding to it. A marker anywhere else just becomes its own chunk
 * boundary.
 *
 * A trigger missing from `pauseMs` entirely is not a boundary at all — the
 * text around it runs on into whatever comes next, as if that trigger didn't
 * exist — rather than a boundary with a 0ms gap. That mirrors the Python
 * module's `pause_ms.get()` semantics, and is what lets a caller pass a
 * subset of the table (as the backend's `build_narration_chunks` does) to opt
 * the bare "." out without every sentence becoming its own TTS request.
 *
 * A period that doesn't actually end a sentence — inside a decimal, an
 * initial, or an abbreviation — is never a boundary regardless of `pauseMs`;
 * see `endsASentence`.
 *
 * Two boundaries with no words between them (e.g. a sentence-ending period
 * immediately followed by a blank line) don't produce an empty chunk — the
 * longer of the two pauses is kept on the previous chunk instead. The same
 * holds for anything between them that isn't speech: a "..." beat on its own
 * line, a "---" rule, a lone emoji. Those mark a pause without being one, so
 * the pause survives on the previous chunk and no chunk is emitted for them —
 * see `hasSpeech`, and never remove that guard: a wordless TTS request comes
 * back as a non-audio body, which is silence here and a failed render in the
 * video pipeline.
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
    if (hasSpeech(segment)) {
      chunks.push({ text: segment, pauseAfterMs: ms })
    } else if (chunks.length > 0) {
      // Nothing sayable between this boundary and the last one — a beat written
      // as "..." on its own line, a "---" rule, a lone emoji. It still marks a
      // pause, so the pause is kept on the chunk before it; what must not
      // happen is a TTS request with no words in it.
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
    const groups = (m.groups ?? {}) as Groups
    const end = m.index + m[0].length
    // A period mid-word isn't a boundary at all: leave it where it is and let
    // the next event's `gap` carry it into the chunk being built.
    if (groups.dot !== undefined && !endsASentence(body, m.index, end)) continue

    const gap = body.slice(pos, m.index)

    if (groups.marker !== undefined) {
      current.push(gap)
      pos = end
      emit(resolveMarker(groups.mval, groups.munit, namedPauseMs))
      continue
    }

    current.push(gap)
    const para = groups.para
    const isPara = para !== undefined
    let ms: number | undefined
    if (isPara) {
      const blankLines = (para.match(/\n/g) ?? []).length - 1
      const base = pauseMs['\n\n']
      ms = base === undefined ? undefined : base * Math.max(1, blankLines)
    } else {
      const ellipsis = groups.ell
      current.push(ellipsis !== undefined ? ellipsis : (groups.dot as string))
      ms = pauseMs[ellipsis !== undefined ? '…' : '.']
    }
    pos = end

    LOOKAHEAD_MARKER_RE.lastIndex = pos
    const override = LOOKAHEAD_MARKER_RE.exec(body)
    if (override !== null) {
      const overrideGroups = (override.groups ?? {}) as Groups
      ms = resolveMarker(overrideGroups.mval, overrideGroups.munit, namedPauseMs)
      pos = LOOKAHEAD_MARKER_RE.lastIndex
    }

    if (ms !== undefined) emit(ms)
    else if (isPara) {
      // A blank line that isn't a pause boundary is still whitespace between
      // two words — drop it entirely (as opposed to a period, which keeps its
      // own character either way) and "text.\n\nHeading" glues into
      // "text.Heading" with no space at all.
      current.push(' ')
    }
  }

  current.push(body.slice(pos))
  const tail = current.join('').trim()
  if (hasSpeech(tail)) {
    chunks.push({ text: tail, pauseAfterMs: 0 })
  } else if (chunks.length > 0) {
    const last = chunks[chunks.length - 1]
    chunks[chunks.length - 1] = { text: last.text, pauseAfterMs: 0 }
  }

  return chunks
}
