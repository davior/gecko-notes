// The web_search plan action: how a model asks the app to search the web.
//
// It exists because only Anthropic can search inside the model call. Every other
// provider (DeepSeek most of all) has no search tool, so the assistant offers it a
// JSON action instead and the app runs the search. These cover the two halves of
// that contract: parsing what the model emits, and rendering what it gets back.

import { describe, expect, it } from 'vitest'

import {
  MAX_WEB_SEARCH_RESULTS,
  defaultActionLabel,
  formatWebSearchResults,
  parsePlan,
  webSearchContinuation,
  type PlanAction,
} from '@/services/aiPlan'
import type { WebSearchResponse } from '@/api/search'

function firstAction(raw: string): PlanAction {
  return parsePlan(raw).actions[0]
}

describe('parsePlan — web_search', () => {
  it('parses a search the model asked for', () => {
    const plan = parsePlan('{"actions":[{"type":"web_search","query":"gecko toe adhesion 2026","maxResults":5}]}')

    expect(plan.actions).toEqual([{ type: 'web_search', query: 'gecko toe adhesion 2026', maxResults: 5 }])
  })

  it('accepts several searches in one round', () => {
    const plan = parsePlan(
      '{"actions":[{"type":"web_search","query":"a"},{"type":"web_search","query":"b"}]}',
    )

    expect(plan.actions.map((a) => a.type)).toEqual(['web_search', 'web_search'])
  })

  it('clamps a runaway maxResults and reads a quoted number', () => {
    expect(firstAction('{"actions":[{"type":"web_search","query":"q","maxResults":500}]}')).toEqual({
      type: 'web_search',
      query: 'q',
      maxResults: MAX_WEB_SEARCH_RESULTS,
    })
    expect(firstAction('{"actions":[{"type":"web_search","query":"q","maxResults":"3"}]}')).toEqual({
      type: 'web_search',
      query: 'q',
      maxResults: 3,
    })
  })

  it('omits maxResults when it is missing or nonsense', () => {
    expect(firstAction('{"actions":[{"type":"web_search","query":"q"}]}')).toEqual({ type: 'web_search', query: 'q' })
    expect(firstAction('{"actions":[{"type":"web_search","query":"q","maxResults":"lots"}]}')).toEqual({
      type: 'web_search',
      query: 'q',
    })
  })

  it('drops a search with no query rather than running an empty one', () => {
    // No valid action survives, so parsePlan falls back to a respond — never a
    // web_search the panel would send to the search API as an empty string.
    const plan = parsePlan('{"actions":[{"type":"web_search","query":"   "}]}')

    expect(plan.actions.every((a) => a.type === 'respond')).toBe(true)
  })

  it('keeps a search alongside the prose a model wrapped it in', () => {
    const plan = parsePlan('Let me look that up.\n{"actions":[{"type":"web_search","query":"tide times hull"}]}')

    expect(plan.actions.map((a) => a.type)).toEqual(['respond', 'web_search'])
  })

  it('survives DeepSeek wrapping the plan in <actions> tags', () => {
    // The XML-ish envelope DeepSeek reaches for instead of the JSON contract; the
    // normaliser folds it back before parsing.
    const plan = parsePlan('<actions>[{"type":"web_search","query":"deepseek r1 pricing"}]</actions>')

    expect(plan.actions).toEqual([{ type: 'web_search', query: 'deepseek r1 pricing' }])
  })

  it('labels a search for the confirmation preview', () => {
    const action: PlanAction = { type: 'web_search', query: 'best gecko vivarium substrate' }

    expect(defaultActionLabel(action, new Map())).toBe('Search the web for “best gecko vivarium substrate”')
  })
})

describe('formatWebSearchResults', () => {
  const response: WebSearchResponse = {
    provider: 'brave',
    provider_label: 'Brave Search API',
    query: 'gecko toe adhesion',
    results: [
      { title: 'How geckos stick', url: 'https://example.com/stick', snippet: 'Van der Waals forces.', published: '2026-02-01' },
      { title: 'Setae explained', url: 'https://example.org/setae', snippet: '' },
    ],
  }

  it('numbers the hits and writes every URL out in full', () => {
    const text = formatWebSearchResults(response)

    // The model is told to cite only URLs it saw, so they have to be present verbatim.
    expect(text).toContain('https://example.com/stick')
    expect(text).toContain('https://example.org/setae')
    expect(text).toContain('1. How geckos stick (published 2026-02-01)')
    expect(text).toContain('2. Setae explained')
    expect(text).toContain('Brave Search API')
  })

  it('says plainly when a search matched nothing', () => {
    const text = formatWebSearchResults({ ...response, results: [] })

    expect(text).toBe('Web search for “gecko toe adhesion” returned no results.')
  })
})

describe('webSearchContinuation', () => {
  it('asks for an answer with citations when a search ran', () => {
    expect(webSearchContinuation(true)).toContain('citing the sources')
  })

  it('tells the model to admit the failure when every search errored', () => {
    // The failure mode this guards: a model that, given no results, answers from
    // memory as though it had searched.
    const text = webSearchContinuation(false)

    expect(text).toContain('web search failed')
    expect(text).toContain('do not answer from memory')
  })
})

// Placing a block (image, diagram, reference, child note) next to a paragraph rather
// than only under a heading. Before this, "an image above every paragraph in chapter 2"
// stacked every image beneath the chapter title, because a heading was the only thing
// a block could be placed against.
describe('parsePlan — block placement', () => {
  it('keeps the anchor and side on every block-inserting action', () => {
    const raws = [
      { type: 'generate_image', noteId: 'n1', prompt: 'p' },
      { type: 'create_diagram', noteId: 'n1', source: 'pie' },
      { type: 'add_reference', noteId: 'n1', referenceNoteId: 'n2', referenceTitle: 'T' },
      { type: 'create_child_note', parentId: 'n1', title: 'C' },
    ]
    for (const raw of raws) {
      const action = firstAction(JSON.stringify({ ...raw, anchorText: 'Storm clouds', position: 'before' }))
      expect(action).toMatchObject({ anchorText: 'Storm clouds', position: 'before' })
    }
  })

  it.each([
    ['above', 'before'], ['Below', 'after'], [' under ', 'after'], ['end', 'end'],
    ['sideways', undefined], ['constructor', undefined],
  ])('folds position %j onto %j', (said, kept) => {
    const action = firstAction(JSON.stringify({ type: 'generate_image', noteId: 'n1', prompt: 'p', position: said }))
    expect((action as { position?: string }).position).toBe(kept)
  })

  it('reads add_reference’s heading from `section` like every other block action', () => {
    const action = firstAction('{"type":"add_reference","noteId":"n1","referenceNoteId":"n2","referenceTitle":"T","section":"Intro"}')
    expect(action).toMatchObject({ insertAfterSection: 'Intro' })
    expect(action).not.toHaveProperty('section')
  })

  it.each([
    [{}, ''],
    [{ section: 'Intro' }, ' under “Intro”'],
    [{ section: 'Intro', position: 'before' }, ' above “Intro”'],
    [{ section: 'Intro', position: 'end' }, ' at the end of “Intro”'],
    [{ section: 'Intro', anchorText: 'Storm clouds', position: 'before' }, ' above “Storm clouds”'],
    [{ anchorText: 'Storm clouds' }, ' below “Storm clouds”'],
  ])('labels %j as landing%s', (fields, suffix) => {
    const action = { type: 'generate_image', noteId: 'n1', prompt: 'p', ...fields } as PlanAction
    expect(defaultActionLabel(action, new Map([['n1', 'Note']]))).toBe(`Generate image${suffix} in “Note”: p`)
  })
})
