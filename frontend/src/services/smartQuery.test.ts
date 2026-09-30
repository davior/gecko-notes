/**
 * Clicking a tag searches for `tags:"name"`. That query must round-trip back to the tag
 * so it can run as a direct tag filter, and must not swallow anything more elaborate —
 * those still go to the AI.
 */

import { describe, expect, it } from 'vitest'
import { parseTagSearchQuery, tagSearchQuery } from './smartQuery'

describe('tag search query', () => {
  it('puts the tag name in quotes', () => {
    expect(tagSearchQuery('confocal-raman')).toBe('tags:"confocal-raman"')
  })

  it('round-trips, including spaces and non-ASCII', () => {
    for (const tag of ['confocal-raman', 'to do', 'café']) {
      expect(parseTagSearchQuery(tagSearchQuery(tag))).toBe(tag)
    }
  })

  it('drops stray quotes so the query stays parseable', () => {
    expect(parseTagSearchQuery(tagSearchQuery('say "hi"'))).toBe('say hi')
  })

  it('tolerates surrounding whitespace and any case for the operator', () => {
    expect(parseTagSearchQuery('  TAGS:"Animals"  ')).toBe('Animals')
  })

  it('leaves anything more than a lone quoted tag to the AI', () => {
    expect(parseTagSearchQuery('tags:Animals')).toBeNull()
    expect(parseTagSearchQuery('tags:"a" and category:Ideas')).toBeNull()
    expect(parseTagSearchQuery('tags:""')).toBeNull()
    expect(parseTagSearchQuery('notes about tags')).toBeNull()
  })
})
