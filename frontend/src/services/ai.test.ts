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
  createAIService,
  extractPlanText,
  isStalledTurn,
  stalledTurnAsText,
  type AnthropicMessageData,
} from './ai'
import { parsePlan } from './aiPlan'
import type { AIProvider } from '@/api/settings'

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

// ─── the body a turn ships to the server ─────────────────────────────────────
//
// Planning runs on a worker now, but the request is still assembled here, because the
// four cache_control breakpoints and their order are what decide whether the prompt
// cache hits — and the worker only ever appends to what it is given. So the layout is
// pinned: a turn that quietly lost a breakpoint would still work, and would silently
// re-bill its whole prefix on every round and every deferred body.

function provider(overrides: Partial<AIProvider> = {}): AIProvider {
  return {
    id: 'p1',
    name: 'Test',
    provider_type: 'anthropic',
    api_key: '',
    base_url: null,
    model: 'claude-x',
    max_tokens: 4096,
    supports_images: true,
    use_anthropic_api: false,
    extra_params: null,
    enabled: true,
    is_active: true,
    ...overrides,
  }
}

const conversation = {
  instructions: 'INSTRUCTIONS',
  referenceBlock: 'REFERENCE',
  history: [
    { role: 'user' as const, content: 'earlier question' },
    { role: 'assistant' as const, content: 'earlier answer' },
  ],
  currentNoteText: 'NOTE BODY',
  userRequest: 'write me an essay',
}

/** Every path through the body that carries a cache breakpoint. */
function breakpoints(body: Record<string, unknown>): string[] {
  const found: string[] = []
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`))
    if (!node || typeof node !== 'object') return
    const obj = node as Record<string, unknown>
    if (obj.cache_control) found.push(path)
    for (const [key, value] of Object.entries(obj)) walk(value, `${path}.${key}`)
  }
  walk(body.system, 'system')
  walk(body.messages, 'messages')
  return found
}

describe('buildPlanRequest', () => {
  it('carries how to reach the provider alongside the body', () => {
    const req = createAIService(provider()).buildPlanRequest(conversation)
    expect(req.protocol).toBe('anthropic')
    expect(req.provider_id).toBe('p1')
    expect(req.model).toBe('claude-x')
    expect(req.max_tokens).toBe(4096)
  })

  it('puts a breakpoint on the instructions, the reference block, the last prior turn and the note', () => {
    // Stable → volatile. The new request comes after the note's breakpoint, so asking
    // a second question never invalidates anything before it.
    const { base_body } = createAIService(provider()).buildPlanRequest(conversation)
    expect(breakpoints(base_body)).toEqual([
      'system[0]',
      'system[1]',
      'messages[1].content[0]',
      'messages[2].content[0]',
    ])
  })

  it('sends the request after the note, in the same volatile message', () => {
    const { base_body } = createAIService(provider()).buildPlanRequest(conversation)
    const messages = base_body.messages as Array<{ content: Array<{ text: string }> }>
    const last = messages[messages.length - 1]
    expect(last.content[0].text).toContain('NOTE BODY')
    expect(last.content[1].text).toContain('write me an essay')
    expect(last.content[1]).not.toHaveProperty('cache_control')
  })

  it('offers the search tool only when this provider searches inside its own call', () => {
    const off = createAIService(provider()).buildPlanRequest(conversation)
    const on = createAIService(provider()).buildPlanRequest({ ...conversation, enableWebSearch: true })
    expect(off.base_body).not.toHaveProperty('tools')
    expect(on.base_body).toHaveProperty('tools')
  })

  it('ships no follow-ups — those are the server\'s to append', () => {
    // Whatever a caller passes, the shipped body is the prefix every later call reads.
    const { base_body } = createAIService(provider()).buildPlanRequest({
      ...conversation,
      followups: [{ role: 'user', content: 'should not be here' }],
    })
    expect(JSON.stringify(base_body)).not.toContain('should not be here')
  })

  it('flattens the conversation for providers with no breakpoints of their own', () => {
    for (const type of ['openai', 'ollama'] as const) {
      const { protocol, base_body } = createAIService(
        provider({ provider_type: type }),
      ).buildPlanRequest(conversation)
      expect(protocol).toBe(type)
      const messages = base_body.messages as Array<{ role: string; content: string }>
      // A system block plus one user message holding the whole conversation — the
      // server appends its follow-ups after that as ordinary turns.
      expect(messages.map((m) => m.role)).toEqual(['system', 'user'])
      expect(messages[0].content).toContain('INSTRUCTIONS')
      expect(messages[1].content).toContain('write me an essay')
      expect(breakpoints(base_body)).toEqual([])
    }
  })
})
