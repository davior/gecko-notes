import type { AIProvider } from '@/api/settings'
import client from '@/api/client'

export interface FileAttachment {
  type: 'image' | 'document'
  mimeType: string
  data: string  // base64-encoded
  name: string
}

export interface AICompleteOptions {
  systemPrompt?: string
  temperature?: number
  prefill?: string
  attachments?: FileAttachment[]
  enableWebSearch?: boolean  // When true: enable Anthropic's built-in web search tool
}

// One prior turn of a chat session, already note-link-stripped by the caller.
export interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

// A full conversation request, broken into pieces by cache stability so the provider
// can place prompt-cache breakpoints optimally (Anthropic) or flatten them into a
// single prompt (OpenAI/Ollama). Order in the rendered prompt is: instructions →
// referenceBlock → history → (currentNoteText + userRequest). Only the last group is
// volatile; everything before it is a stable, cacheable prefix.
export interface ConversationRequest {
  instructions: string          // static system block (cached every request)
  referenceBlock?: string       // id/title lists + other notes' bodies (cached; stable per conversation)
  history: ConversationTurn[]   // prior turns; the latest is the rolling cache breakpoint
  currentNoteText?: string      // live body of the open note — volatile, sent last, uncached
  userRequest: string           // the new user message — volatile, sent last
  attachments?: FileAttachment[]
  temperature?: number
  enableWebSearch?: boolean
}

export interface NoteMetadata {
  title: string
  tags: string[]
  summary: string
}

export interface AIService {
  complete(prompt: string, options?: AICompleteOptions): Promise<string>
  // Cache-optimised chat turn used by the AI Conversation panel. See ConversationRequest.
  completeConversation(req: ConversationRequest): Promise<string>
  generateTags(noteContent: string): Promise<string[]>
  generateSummary(noteContent: string, prompt: string): Promise<string>
  generateMetadata(noteContent: string, summaryPrompt: string, includeTitle?: boolean): Promise<NoteMetadata>
  summarise(noteContent: string): Promise<string>
  improveWriting(text: string): Promise<string>
  continueWriting(context: string): Promise<string>
  testConnection(): Promise<boolean>
}

// Appended when a provider stops at its output-token cap so the user knows the reply
// is incomplete and can ask to continue.
const TRUNCATION_NOTICE =
  '\n\n---\n*This response was cut off due to length. You can ask me to continue, or request the information in smaller parts.*'

// Anthropic user-content block shapes (text + base64 image/document attachments).
type AnthropicContentBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string }; title?: string }

function attachmentToBlock(a: FileAttachment): AnthropicContentBlock {
  return a.type === 'image'
    ? { type: 'image', source: { type: 'base64', media_type: a.mimeType, data: a.data } }
    : { type: 'document', source: { type: 'base64', media_type: a.mimeType, data: a.data }, title: a.name }
}

// Label for the open note's live body so the model treats the latest user message as
// authoritative current context. Must match the wording referenced in PLAN_INSTRUCTIONS.
function buildCurrentNoteMessage(currentNoteText: string | undefined, userRequest: string): string {
  return currentNoteText
    ? `Current note — live, reflects the latest edits:\n\n${currentNoteText}\n\n---\n\n${userRequest}`
    : userRequest
}

// OpenAI/Ollama have no prompt cache, so flatten a ConversationRequest back into the
// single system-string + transcript-prompt shape complete() already handles. This keeps
// their behaviour identical to before this change (only Anthropic gets cache breakpoints).
function flattenConversation(req: ConversationRequest): { prompt: string; options: AICompleteOptions } {
  const contextParts = [
    req.referenceBlock,
    req.currentNoteText ? `Current note:\n\n${req.currentNoteText}` : '',
  ].filter(Boolean)
  const systemPrompt = [req.instructions, ...contextParts].join('\n\n')
  const transcript = req.history
    .map((m) => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
    .join('\n\n')
  const prompt = transcript ? `${transcript}\n\nHuman: ${req.userRequest}` : req.userRequest
  return { prompt, options: { systemPrompt, attachments: req.attachments, temperature: req.temperature } }
}

const TAG_GENERATION_PROMPT = `You are a tagging assistant. Analyse the following note content and return between 3 and 8 short, relevant tags as a JSON array of lowercase strings. Return ONLY the JSON array, no other text.

Content:
{note_content}`

function parseTagsFromAI(raw: string): string[] {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  const parsed = JSON.parse(cleaned)
  if (!Array.isArray(parsed)) throw new Error('not an array')
  return parsed.map(String)
}

function parseMetadataFromAI(raw: string): NoteMetadata {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  const parsed = JSON.parse(cleaned)
  return {
    title: typeof parsed.title === 'string' ? parsed.title : '',
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
  }
}

// Build the system prompt for generateMetadata. When includeTitle is set it also
// asks for a concise title (used when the note is still untitled). Shared by all
// providers to avoid triplicating the instruction text.
function buildMetadataSystem(summaryPrompt: string, includeTitle: boolean): string {
  const titleInstruction = includeTitle
    ? '\nAlso generate a concise title for this note (at most 8 words, plain text, no surrounding quotes).'
    : ''
  const fields = includeTitle
    ? '"title" (string), "summary" (string) and "tags" (string array)'
    : '"summary" (string) and "tags" (string array)'
  return `${summaryPrompt}\n\nAlso generate 3–8 short lowercase tags for this note.${titleInstruction}\n\nReturn a JSON object with fields ${fields}. Return ONLY the JSON, no other text.`
}

export const DEFAULT_SUMMARY_PROMPT = `You are a knowledge indexing assistant. Create a dense, factual summary of the following note optimised for use in a Retrieval-Augmented Generation (RAG) system.

Requirements:
- Capture the main topic, key facts, named entities, dates, numbers, and relationships
- Be self-contained and understandable without the full note
- Aim for 100-200 words
- Use plain, direct language — no preamble like "This note discusses..."
- Preserve technical terms, proper nouns, and specific details exactly

Return only the summary text, no preamble or explanation.`

// ─── Anthropic Provider ───────────────────────────────────────────────────────

class AnthropicProvider implements AIService {
  constructor(private config: { id: string; model: string; maxTokens: number }) {}

  async complete(prompt: string, options: AICompleteOptions = {}): Promise<string> {
    const { systemPrompt, temperature, prefill, attachments, enableWebSearch } = options

    let userContent: string | AnthropicContentBlock[]
    if (attachments?.length) {
      const blocks: AnthropicContentBlock[] = attachments.map(attachmentToBlock)
      blocks.push({ type: 'text', text: prompt })
      userContent = blocks
    } else {
      userContent = prompt
    }

    const messages: { role: string; content: unknown }[] = [{ role: 'user', content: userContent }]
    if (prefill) {
      messages.push({ role: 'assistant', content: prefill })
    }

    const body: Record<string, unknown> = {
      provider_id: this.config.id,
      model: this.config.model,
      // Caps the *response* length (output tokens), not the note/input. Configured
      // per provider (Settings → AI Providers). Safe to set high because the proxy
      // streams — before streaming, a larger cap made the upstream read timeout
      // worse. Keep it within the model's output ceiling (e.g. 64000 for Sonnet/
      // Haiku, 128000 for Opus) or Anthropic rejects the request with a 400.
      max_tokens: this.config.maxTokens,
      messages,
    }
    if (systemPrompt) body.system = systemPrompt
    if (temperature !== undefined) body.temperature = temperature
    if (enableWebSearch) {
      body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]
    }

    const response = await client.post('/settings/ai-providers/proxy/anthropic', body)
    const text = this.extractPlanText(response.data)
    const full = prefill ? prefill + text : text
    return response.data?.stop_reason === 'max_tokens' ? full + TRUNCATION_NOTICE : full
  }

  // Cache-optimised chat turn for the AI Conversation panel. Layout (stable → volatile):
  //   system:   [ instructions (cache breakpoint), referenceBlock (cache breakpoint) ]
  //   messages: [ ...history (rolling cache breakpoint on the latest prior turn),
  //               { user: live note body + new request + attachments } ]
  // The volatile final message has no breakpoint, so editing the open note or asking a
  // new question never invalidates the cached instructions/reference/history prefix.
  async completeConversation(req: ConversationRequest): Promise<string> {
    const { instructions, referenceBlock, currentNoteText, history, userRequest, attachments, temperature, enableWebSearch } = req

    const system: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[] = [
      { type: 'text', text: instructions, cache_control: { type: 'ephemeral' } },
    ]
    if (referenceBlock) system.push({ type: 'text', text: referenceBlock, cache_control: { type: 'ephemeral' } })

    // The rolling breakpoint goes on the last prior turn, so the cached conversation
    // prefix grows by one turn each request instead of being re-billed in full.
    const lastIdx = history.length - 1
    const messages: { role: string; content: unknown }[] = history.map((m, i) =>
      i === lastIdx
        ? { role: m.role, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] }
        : { role: m.role, content: m.content }
    )

    const finalText = buildCurrentNoteMessage(currentNoteText, userRequest)
    if (attachments?.length) {
      const blocks: AnthropicContentBlock[] = attachments.map(attachmentToBlock)
      blocks.push({ type: 'text', text: finalText })
      messages.push({ role: 'user', content: blocks })
    } else {
      messages.push({ role: 'user', content: finalText })
    }

    const body: Record<string, unknown> = {
      provider_id: this.config.id,
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      messages,
      system,
    }
    if (temperature !== undefined) body.temperature = temperature
    if (enableWebSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]

    const response = await client.post('/settings/ai-providers/proxy/anthropic', body)
    const text = this.extractPlanText(response.data)
    return response.data?.stop_reason === 'max_tokens' ? text + TRUNCATION_NOTICE : text
  }

  // Join all text blocks. When web search runs, the content may interleave
  // server_tool_use / web_search_tool_result blocks with text — we keep only text.
  // If Claude misfired a *described* plan action (edit_note, …) as a native tool_use
  // block instead of emitting the JSON envelope, recover the plan from it. This is NOT
  // gated on empty text: with web search, Claude emits running commentary as text even
  // when the real action lives in a tool_use block, so gating on `!text` would drop it.
  private extractPlanText(
    data: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>; stop_reason?: string } | undefined,
  ): string {
    const contentBlocks = data?.content ?? []
    let text = contentBlocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
    if (data?.stop_reason === 'tool_use') {
      const actions = contentBlocks
        .filter((b) => b.type === 'tool_use' && b.input && typeof b.input === 'object')
        .map((b) => {
          const input = { ...(b.input as Record<string, unknown>) }
          if (!input.type && b.name) input.type = b.name
          return input
        })
      if (actions.length) text = JSON.stringify({ actions })
    }
    return text
  }

  async generateTags(noteContent: string): Promise<string[]> {
    const prompt = TAG_GENERATION_PROMPT.replace('{note_content}', noteContent)
    const result = await this.complete(prompt)
    try {
      return parseTagsFromAI(result)
    } catch {
      return []
    }
  }

  async generateSummary(noteContent: string, prompt: string): Promise<string> {
    return this.complete(noteContent, { systemPrompt: prompt })
  }

  async generateMetadata(noteContent: string, summaryPrompt: string, includeTitle = false): Promise<NoteMetadata> {
    const system = buildMetadataSystem(summaryPrompt, includeTitle)
    const result = await this.complete(noteContent, { systemPrompt: system })
    try {
      return parseMetadataFromAI(result)
    } catch {
      return { title: '', tags: [], summary: '' }
    }
  }

  async summarise(noteContent: string): Promise<string> {
    return this.complete(
      `Please summarise the following note content concisely:\n\n${noteContent}`,
      { systemPrompt: 'You are a helpful writing assistant. Provide clear, concise summaries.' }
    )
  }

  async improveWriting(text: string): Promise<string> {
    return this.complete(
      `Please improve the following text for clarity and style, keeping the same meaning:\n\n${text}`,
      { systemPrompt: 'You are a skilled editor. Improve writing while preserving the author\'s voice and meaning.' }
    )
  }

  async continueWriting(context: string): Promise<string> {
    return this.complete(
      `Please continue writing from where this text leaves off:\n\n${context}`,
      { systemPrompt: 'You are a helpful writing assistant. Continue the text naturally and coherently.' }
    )
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.complete('Hi', { systemPrompt: 'Respond with just "ok"' })
      return true
    } catch {
      return false
    }
  }
}

// ─── OpenAI / Custom OpenAI-compatible Provider ───────────────────────────────

class OpenAIProvider implements AIService {
  constructor(private config: { id: string; model: string; maxTokens: number }) {}

  async complete(prompt: string, options: AICompleteOptions = {}): Promise<string> {
    const { systemPrompt, temperature, prefill, attachments } = options
    const messages: { role: string; content: unknown }[] = []
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })

    if (attachments?.length) {
      const contentBlocks = [
        ...attachments.map((a) => ({
          type: 'image_url' as const,
          image_url: { url: `data:${a.mimeType};base64,${a.data}` },
        })),
        { type: 'text' as const, text: prompt },
      ]
      messages.push({ role: 'user', content: contentBlocks })
    } else {
      messages.push({ role: 'user', content: prompt })
    }

    if (prefill) messages.push({ role: 'assistant', content: prefill })

    const body: Record<string, unknown> = {
      provider_id: this.config.id,
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      messages,
    }
    if (temperature !== undefined) body.temperature = temperature

    const response = await client.post('/settings/ai-providers/proxy/openai', body)
    const text = response.data?.choices?.[0]?.message?.content ?? ''
    const full = prefill ? prefill + text : text
    if (response.data?.choices?.[0]?.finish_reason === 'length') {
      return full + '\n\n---\n*This response was cut off due to length. You can ask me to continue, or request the information in smaller parts.*'
    }
    return full
  }

  async completeConversation(req: ConversationRequest): Promise<string> {
    const { prompt, options } = flattenConversation(req)
    return this.complete(prompt, options)
  }

  async generateTags(noteContent: string): Promise<string[]> {
    const prompt = TAG_GENERATION_PROMPT.replace('{note_content}', noteContent)
    const result = await this.complete(prompt)
    try {
      return parseTagsFromAI(result)
    } catch {
      return []
    }
  }

  async generateSummary(noteContent: string, prompt: string): Promise<string> {
    return this.complete(noteContent, { systemPrompt: prompt })
  }

  async generateMetadata(noteContent: string, summaryPrompt: string, includeTitle = false): Promise<NoteMetadata> {
    const system = buildMetadataSystem(summaryPrompt, includeTitle)
    const result = await this.complete(noteContent, { systemPrompt: system })
    try {
      return parseMetadataFromAI(result)
    } catch {
      return { title: '', tags: [], summary: '' }
    }
  }

  async summarise(noteContent: string): Promise<string> {
    return this.complete(
      `Please summarise the following note content concisely:\n\n${noteContent}`,
      { systemPrompt: 'You are a helpful writing assistant. Provide clear, concise summaries.' }
    )
  }

  async improveWriting(text: string): Promise<string> {
    return this.complete(
      `Please improve the following text for clarity and style, keeping the same meaning:\n\n${text}`,
      { systemPrompt: 'You are a skilled editor. Improve writing while preserving the author\'s voice and meaning.' }
    )
  }

  async continueWriting(context: string): Promise<string> {
    return this.complete(
      `Please continue writing from where this text leaves off:\n\n${context}`,
      { systemPrompt: 'You are a helpful writing assistant. Continue the text naturally and coherently.' }
    )
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.complete('Hi', { systemPrompt: 'Respond with just "ok"' })
      return true
    } catch {
      return false
    }
  }
}

// ─── Ollama Provider ──────────────────────────────────────────────────────────

class OllamaProvider implements AIService {
  constructor(private config: { id: string; model: string; maxTokens: number }) {}

  async complete(prompt: string, options: AICompleteOptions = {}): Promise<string> {
    const { systemPrompt, temperature, prefill, attachments } = options
    const messages: { role: string; content: unknown }[] = []
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })

    if (attachments?.length) {
      const contentBlocks = [
        ...attachments.map((a) => ({
          type: 'image_url' as const,
          image_url: { url: `data:${a.mimeType};base64,${a.data}` },
        })),
        { type: 'text' as const, text: prompt },
      ]
      messages.push({ role: 'user', content: contentBlocks })
    } else {
      messages.push({ role: 'user', content: prompt })
    }

    if (prefill) messages.push({ role: 'assistant', content: prefill })

    const body: Record<string, unknown> = {
      provider_id: this.config.id,
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      messages,
    }
    if (temperature !== undefined) body.temperature = temperature

    const response = await client.post('/settings/ai-providers/proxy/ollama', body)
    const text = response.data?.message?.content ?? ''
    const full = prefill ? prefill + text : text
    if (response.data?.done_reason === 'length') {
      return full + '\n\n---\n*This response was cut off due to length. You can ask me to continue, or request the information in smaller parts.*'
    }
    return full
  }

  async completeConversation(req: ConversationRequest): Promise<string> {
    const { prompt, options } = flattenConversation(req)
    return this.complete(prompt, options)
  }

  async generateTags(noteContent: string): Promise<string[]> {
    const prompt = TAG_GENERATION_PROMPT.replace('{note_content}', noteContent)
    const result = await this.complete(prompt)
    try {
      return parseTagsFromAI(result)
    } catch {
      return []
    }
  }

  async generateSummary(noteContent: string, prompt: string): Promise<string> {
    return this.complete(noteContent, { systemPrompt: prompt })
  }

  async generateMetadata(noteContent: string, summaryPrompt: string, includeTitle = false): Promise<NoteMetadata> {
    const system = buildMetadataSystem(summaryPrompt, includeTitle)
    const result = await this.complete(noteContent, { systemPrompt: system })
    try {
      return parseMetadataFromAI(result)
    } catch {
      return { title: '', tags: [], summary: '' }
    }
  }

  async summarise(noteContent: string): Promise<string> {
    return this.complete(`Please summarise the following note content concisely:\n\n${noteContent}`)
  }

  async improveWriting(text: string): Promise<string> {
    return this.complete(`Please improve the following text for clarity and style:\n\n${text}`)
  }

  async continueWriting(context: string): Promise<string> {
    return this.complete(`Please continue writing from where this text leaves off:\n\n${context}`)
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.complete('Hi')
      return true
    } catch {
      return false
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createAIService(provider: AIProvider): AIService {
  switch (provider.provider_type) {
    case 'anthropic':
      return new AnthropicProvider({
        id: provider.id,
        model: provider.model,
        maxTokens: provider.max_tokens ?? 16384,
      })
    case 'openai':
    case 'custom':
      return new OpenAIProvider({
        id: provider.id,
        model: provider.model,
        maxTokens: provider.max_tokens ?? 16384,
      })
    case 'ollama':
      return new OllamaProvider({
        id: provider.id,
        model: provider.model,
        maxTokens: provider.max_tokens ?? 16384,
      })
    default:
      throw new Error(`Unknown provider type: ${provider.provider_type}`)
  }
}
