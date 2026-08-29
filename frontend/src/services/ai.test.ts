// Tests for reading an Anthropic-protocol reply — and for finishing one the provider
// left unfinished.
//
// The shapes here are taken from a real DeepSeek session (`deepseek-v4-pro` on
// api.deepseek.com/anthropic) in which the assistant repeatedly announced a plan and
// never produced one. Its replies came back with `stop_reason: "tool_use"` and nothing
// but `server_tool_use` calls the provider had already answered itself — the last two
// with `max_uses_exceeded`. Anthropic's own endpoint never does this: server-side
// search finishes inside the call and the turn ends with `end_turn`.

import { describe, it, expect } from 'vitest'
import {
  continuationBody,
  extractPlanText,
  isStalledTurn,
  stalledTurnAsText,
  type AnthropicMessageData,
} from './ai'
import { parsePlan } from './aiPlan'

const searchCall = (query: string) => ({ type: 'server_tool_use', name: 'web_search', input: { query } })
const hits = (...results: Array<{ title: string; url: string }>) => ({
  type: 'web_search_tool_result',
  content: results.map((r) => ({ type: 'web_search_result', ...r, encrypted_content: 'opaque' })),
})
const exhausted = {
  type: 'web_search_tool_result',
  content: [{ type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' }],
}

// The reply that produced the bug: commentary, five real searches, then two refused
// ones — and no plan JSON anywhere.
const stalledReply: AnthropicMessageData = {
  stop_reason: 'tool_use',
  content: [
    { type: 'thinking', text: undefined },
    { type: 'text', text: "I'll create the companion Substack article as a new note." },
    searchCall('Substack article best practices structure'),
    hits({ title: 'Everything You Need to Know About Posting', url: 'https://example.com/posting' }),
    { type: 'text', text: 'I have everything I need from your video script.' },
    searchCall('Substack companion article video embed'),
    exhausted,
  ],
}

describe('isStalledTurn', () => {
  it('flags a turn stopped on server-side search the provider already answered', () => {
    expect(isStalledTurn(stalledReply)).toBe(true)
  })

  it('leaves a completed turn alone', () => {
    expect(isStalledTurn({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"actions":[]}' }] })).toBe(false)
  })

  it('leaves a client-side tool_use alone — extractPlanText reads a plan out of that', () => {
    const data: AnthropicMessageData = {
      stop_reason: 'tool_use',
      content: [searchCall('anything'), hits({ title: 'T', url: 'https://example.com' }),
        { type: 'tool_use', name: 'create_note', input: { title: 'Draft' } }],
    }
    expect(isStalledTurn(data)).toBe(false)
    expect(JSON.parse(extractPlanText(data))).toEqual({ actions: [{ type: 'create_note', title: 'Draft' }] })
  })

  it('ignores a reply with no tool blocks at all', () => {
    expect(isStalledTurn({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'hi' }] })).toBe(false)
    expect(isStalledTurn(undefined)).toBe(false)
  })
})

describe('stalledTurnAsText', () => {
  it('replays what the model said plus the hits it already has, as plain text', () => {
    const text = stalledTurnAsText(stalledReply)
    expect(text).toContain("I'll create the companion Substack article as a new note.")
    expect(text).toContain('I have everything I need from your video script.')
    expect(text).toContain('Search “Substack article best practices structure”:')
    expect(text).toContain('- Everything You Need to Know About Posting — https://example.com/posting')
  })

  it('carries no tool_use, thinking or result blocks a gateway could reject', () => {
    expect(stalledTurnAsText(stalledReply)).not.toContain('encrypted_content')
    expect(stalledTurnAsText(stalledReply)).not.toContain('server_tool_use')
  })

  it('says nothing about searches that only errored', () => {
    const text = stalledTurnAsText({
      stop_reason: 'tool_use',
      content: [{ type: 'text', text: 'Working on it.' }, searchCall('q'), exhausted],
    })
    expect(text).toBe('Working on it.')
  })

  it('is never empty — an assistant turn may not be blank', () => {
    expect(stalledTurnAsText({ stop_reason: 'tool_use', content: [searchCall('q'), exhausted] })).toBe('(searching)')
  })
})

describe('continuationBody', () => {
  const body = {
    model: 'deepseek-v4-pro',
    system: [{ type: 'text', text: 'plan instructions', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'write the article' }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
  }

  it('drops the search tool so the loop that stalled cannot restart', () => {
    expect(continuationBody(body, stalledReply).tools).toBeUndefined()
    expect(body.tools).toBeDefined()  // the original body is not mutated
  })

  it('keeps the cached prefix byte-identical and appends the two new turns', () => {
    const next = continuationBody(body, stalledReply)
    const messages = next.messages as Array<{ role: string; content: unknown }>
    expect(next.system).toBe(body.system)
    expect(messages.slice(0, 1)).toEqual(body.messages)
    expect(messages).toHaveLength(3)
    expect(messages[1].role).toBe('assistant')
    expect(messages[2].role).toBe('user')
    expect(messages[2].content).toContain('search budget is spent')
  })
})

describe('extractPlanText', () => {
  it('separates commentary written either side of a search', () => {
    // The bug the user saw: joined with '', these ran together as
    // "…as a new note.I have everything I need…".
    expect(extractPlanText(stalledReply)).toBe(
      "I'll create the companion Substack article as a new note.\n\nI have everything I need from your video script.",
    )
  })

  it('keeps adjacent text blocks continuous — Anthropic splits a paragraph at citations', () => {
    const data: AnthropicMessageData = {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Rates rose ' }, { type: 'text', text: 'in March.' }],
    }
    expect(extractPlanText(data)).toBe('Rates rose in March.')
  })

  it('a stalled turn parses as prose, not a plan — which is why it must be continued', () => {
    expect(parsePlan(extractPlanText(stalledReply)).actions.every((a) => a.type === 'respond')).toBe(true)
  })

  it('a continued turn parses as the real plan', () => {
    const finished: AnthropicMessageData = {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"actions":[{"type":"create_note","title":"The Mass Delusion","content":"Body."}]}' }],
    }
    expect(parsePlan(extractPlanText(finished)).actions).toEqual([
      { type: 'create_note', title: 'The Mass Delusion', content: 'Body.' },
    ])
  })
})
