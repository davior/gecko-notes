// Parity checks for the pause-markup parser.
//
// The cases come from backend/tests/fixtures/pause_cases.json, which
// test_pause_markup.py asserts against too — so a rule changed on one side and
// not the other fails on whichever side was left behind. Three divergences had
// already accumulated before this file existed: an unknown level raised on the
// backend but returned 0 here, a partial pause_ms dict produced NaN here, and
// the frontend had no test infrastructure at all.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MARKER_MS,
  DEFAULT_PAUSE_MS,
  MAX_PAUSE_MS,
  parsePauseMarkup,
  stripPauseMarkup,
} from '@/utils/pauseMarkup'

interface ParseCase {
  name: string
  text: string
  pauseMs: string | null
  expect: [string, number][]
}
interface StripCase { text: string; expect: string }

const fixture = JSON.parse(
  readFileSync(new URL('../../../backend/tests/fixtures/pause_cases.json', import.meta.url), 'utf-8'),
) as {
  pauseMsSets: Record<string, Record<string, number>>
  parse: ParseCase[]
  strip: StripCase[]
}

const flatten = (text: string, pauseMs?: Record<string, number>) =>
  parsePauseMarkup(text, pauseMs).map((c) => [c.text, c.pauseAfterMs])

describe('parsePauseMarkup — shared table', () => {
  for (const testCase of fixture.parse) {
    it(testCase.name, () => {
      const pauseMs = testCase.pauseMs === null
        ? DEFAULT_PAUSE_MS
        : fixture.pauseMsSets[testCase.pauseMs]
      expect(flatten(testCase.text, pauseMs)).toEqual(testCase.expect)
    })
  }
})

describe('stripPauseMarkup — shared table', () => {
  for (const testCase of fixture.strip) {
    it(testCase.text.slice(0, 40), () => {
      expect(stripPauseMarkup(testCase.text)).toBe(testCase.expect)
    })
  }
})

describe('parsePauseMarkup — frontend-specific guards', () => {
  it('never produces a NaN pause from a partial dict', () => {
    // An unbounded setTimeout is how a NaN here would actually be felt:
    // playback stops dead between two chunks and never resumes.
    for (const chunk of parsePauseMarkup('a. b... c.\n\nd.', { '…': 1300 })) {
      expect(Number.isFinite(chunk.pauseAfterMs)).toBe(true)
    }
  })

  it('never produces a NaN pause from an empty dict', () => {
    for (const chunk of parsePauseMarkup('a. b... c.\n\nd.', {})) {
      expect(Number.isFinite(chunk.pauseAfterMs)).toBe(true)
    }
  })

  it('resolves an unknown level rather than throwing', () => {
    expect(() => parsePauseMarkup('a [pause:nonsense] b')).not.toThrow()
    expect(parsePauseMarkup('a [pause:nonsense] b')[0].pauseAfterMs).toBe(DEFAULT_MARKER_MS)
  })

  it('clamps an absurd duration', () => {
    expect(parsePauseMarkup('a [pause:999999] b')[0].pauseAfterMs).toBe(MAX_PAUSE_MS)
  })

  it('always ends with a zero pause', () => {
    for (const text of ['a. b.', 'a [pause:2s] b', 'trailing [pause:2s]', 'a...']) {
      const chunks = parsePauseMarkup(text)
      expect(chunks[chunks.length - 1].pauseAfterMs).toBe(0)
    }
  })

  it('leaves no marker text to be spoken', () => {
    const spellings = [
      '[pause]', '[pause:15]', '[pause: 15]', '[pause 15]', '[Pause:15]',
      '[PAUSE : 2S]', '[pause=400ms]', '[pause:1.5]', '[pause:xlong]', '[pause:xxlong]',
    ]
    for (const spelling of spellings) {
      const spoken = parsePauseMarkup(`before ${spelling} after`).map((c) => c.text).join(' ')
      expect(spoken.toLowerCase()).not.toContain('pause')
      expect(spoken).toBe('before after')
    }
  })
})
