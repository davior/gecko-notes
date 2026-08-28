// Parity checks for whole-text chunking.
//
// `/settings/speech/narrate` re-synthesises these exact chunks to stitch
// silence between them, and only identical chunk text hits the server's TTS
// disk cache — so a split that drifts from `_pack_export_chunks` in
// backend/app/routers/settings.py means paying for the same audio twice. Both
// sides assert the `chunk` section of backend/tests/fixtures/pause_cases.json.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { MAX_CHUNK_CHARS, chunkText, chunkTextForPlayback, stripEmoji } from '@/utils/speechChunks'

interface ChunkCase { name: string; text: string; expect: [string, number][] }

const fixture = JSON.parse(
  readFileSync(new URL('../../../backend/tests/fixtures/pause_cases.json', import.meta.url), 'utf-8'),
) as { chunk: ChunkCase[] }

describe('chunkText — shared table', () => {
  for (const testCase of fixture.chunk) {
    it(testCase.name, () => {
      expect(chunkText(testCase.text).map((c) => [c.text, c.pauseAfterMs])).toEqual(testCase.expect)
    })
  }
})

describe('chunkText — length splitting', () => {
  it('keeps every chunk under the per-request cap', () => {
    const chunks = chunkText('word '.repeat(2000) + 'end.')
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS)
  })

  it('splits on a word boundary, never mid-word', () => {
    for (const chunk of chunkText('word '.repeat(2000) + 'end.')) {
      expect(chunk.text.startsWith('word') || chunk.text.startsWith('end')).toBe(true)
      expect(chunk.text.endsWith('word') || chunk.text.endsWith('end.')).toBe(true)
    }
  })

  it('does not pause at a split forced by length', () => {
    const chunks = chunkText('word '.repeat(2000) + 'end.')
    for (const chunk of chunks.slice(0, -1)) expect(chunk.pauseAfterMs).toBe(0)
  })

  it('returns nothing for empty or blank text', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   ')).toEqual([])
  })
})

describe('stripEmoji', () => {
  it('drops pictographs the voice would otherwise describe', () => {
    expect(stripEmoji('Drive the car 🚗 home')).toBe('Drive the car  home')
    expect(stripEmoji('Flag 🇬🇧 here')).toBe('Flag  here')
    expect(stripEmoji('Family 👨‍👩‍👧 here')).toBe('Family  here')
  })
})

describe('playback and export chunk identically', () => {
  // The backend splits narrate requests one way only, so Insert Mode — which
  // plays with chunkTextForPlayback and then asks the server to narrate the
  // same text — depends on these agreeing. They do today because the ramped
  // targets only gate *entry* into the re-split branch, and that branch cuts
  // at MAX_CHUNK_CHARS either way. If this ever fails, the ramp has started to
  // bite and `_pack_export_chunks` needs the same sizes or Insert Mode will
  // miss the TTS cache and be billed twice for audio it already fetched.
  const samples = [
    'One. Two. Three. Four. Five.',
    'word '.repeat(80) + 'end.',
    'word '.repeat(800) + 'end.',
    'Short intro. ' + 'word '.repeat(120) + 'mid. Tail here.',
    'A beat... [pause:2s] and on.\n\nNew paragraph.',
  ]
  for (const [index, text] of samples.entries()) {
    it(`sample ${index + 1}`, () => {
      expect(chunkTextForPlayback(text)).toEqual(chunkText(text))
    })
  }
})
