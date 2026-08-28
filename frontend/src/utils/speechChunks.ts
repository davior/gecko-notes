// Splitting note text into TTS requests, shared by read-aloud playback, the
// audio export, and Insert Mode.
//
// Lives outside `useTextToSpeech` because the backend has to reproduce this
// split byte for byte: `/settings/speech/narrate` re-synthesises the same
// chunks to lay real silence between them, and only identical chunk text hits
// the server's TTS disk cache instead of paying for the audio twice. The
// counterpart is `_pack_export_chunks` in `backend/app/routers/settings.py`;
// `speechChunks.test.ts` checks the two against one shared table.

import { parsePauseMarkup, type SpeechChunk } from '@/utils/pauseMarkup'

export type { SpeechChunk }

// The TTS endpoint caps text per request (~2000 chars). Stay comfortably below
// and split on sentence/line boundaries so each chunk sounds natural.
export const MAX_CHUNK_CHARS = 1500

// Progressive per-chunk size targets for playback. The first chunk is kept
// small (~1-2 sentences) so fal renders it in ~1s and audio starts almost
// immediately; later chunks ramp up to full size to keep request overhead low
// and prosody natural. Sizes hold at MAX_CHUNK_CHARS after the ramp.
export const PLAYBACK_CHUNK_TARGETS = [220, 500, 1000, MAX_CHUNK_CHARS]

// Matches emoji (pictographs, flag sequences, skin-tone modifiers) plus the
// zero-width joiner / variation-selector / keycap marks used to build them,
// so they can be dropped before synthesis — otherwise the TTS engine reads
// them out by description (e.g. "🚗" becomes the spoken word "car").
const EMOJI_REGEX = new RegExp(
  '[\\u{1F1E6}-\\u{1F1FF}]{2}' + // flag sequences (pairs of regional indicators)
  '|[\\p{Extended_Pictographic}\\u{1F3FB}-\\u{1F3FF}]' + // pictographs + skin-tone modifiers
  '|[\\u200D\\uFE0F\\u20E3]', // ZWJ, variation selector, keycap combiner
  'gu',
)

export function stripEmoji(text: string): string {
  return text.replace(EMOJI_REGEX, '')
}

// Split at sentence/paragraph/[pause:...] boundaries (see parsePauseMarkup)
// and re-split any resulting segment that's still over the Nth chunk's size
// budget `limitFor(N)`, same word-boundary hard-split the provider's
// character cap has always needed. Only the final piece of a re-split
// segment keeps that segment's own pause — the pieces before it are joins
// forced by length, not a place the narration should actually pause.
//
// Runs of spaces and tabs collapse; newlines never do, because a blank line is
// what parsePauseMarkup reads as a paragraph break.
function packSpeechChunks(text: string, limitFor: (index: number) => number): SpeechChunk[] {
  const segments = parsePauseMarkup(stripEmoji(text).replace(/[ \t]+/g, ' '))
  const packed: SpeechChunk[] = []
  for (const segment of segments) {
    if (segment.text.length <= limitFor(packed.length)) {
      packed.push(segment)
      continue
    }
    let rest = segment.text
    while (rest.length > MAX_CHUNK_CHARS) {
      let cut = rest.lastIndexOf(' ', MAX_CHUNK_CHARS)
      if (cut <= 0) cut = MAX_CHUNK_CHARS
      packed.push({ text: rest.slice(0, cut).trim(), pauseAfterMs: 0 })
      rest = rest.slice(cut).trim()
    }
    packed.push({ text: rest, pauseAfterMs: segment.pauseAfterMs })
  }
  return packed
}

// Uniform chunks — used for whole-file synthesis (audio export), where there's
// no first-audio latency to optimise.
export function chunkText(text: string): SpeechChunk[] {
  return packSpeechChunks(text, () => MAX_CHUNK_CHARS)
}

// Fast-start chunks for playback: a small first chunk, ramping up to full size.
export function chunkTextForPlayback(text: string): SpeechChunk[] {
  return packSpeechChunks(text, (i) => PLAYBACK_CHUNK_TARGETS[Math.min(i, PLAYBACK_CHUNK_TARGETS.length - 1)])
}
