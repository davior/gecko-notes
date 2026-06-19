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
  cacheSystem?: boolean  // When true: mark system prompt for Anthropic prompt cache
  enableWebSearch?: boolean  // When true: enable Anthropic's built-in web search tool
}

export interface NoteMetadata {
  tags: string[]
  summary: string
}

export interface AIService {
  complete(prompt: string, options?: AICompleteOptions): Promise<string>
  generateTags(noteContent: string): Promise<string[]>
  generateSummary(noteContent: string, prompt: string): Promise<string>
  generateMetadata(noteContent: string, summaryPrompt: string): Promise<NoteMetadata>
  summarise(noteContent: string): Promise<string>
  improveWriting(text: string): Promise<string>
  continueWriting(context: string): Promise<string>
  testConnection(): Promise<boolean>
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
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
  }
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
  constructor(private config: { id: string; model: string }) {}

  async complete(prompt: string, options: AICompleteOptions = {}): Promise<string> {
    const { systemPrompt, temperature, prefill, attachments, cacheSystem, enableWebSearch } = options

    type AnthropicContentBlock =
      | { type: 'text'; text: string }
      | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
      | { type: 'document'; source: { type: 'base64'; media_type: string; data: string }; title?: string }

    let userContent: string | AnthropicContentBlock[]
    if (attachments?.length) {
      const blocks: AnthropicContentBlock[] = attachments.map((a) =>
        a.type === 'image'
          ? { type: 'image', source: { type: 'base64', media_type: a.mimeType, data: a.data } }
          : { type: 'document', source: { type: 'base64', media_type: a.mimeType, data: a.data }, title: a.name }
      )
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
      max_tokens: 16384,
      messages,
    }
    if (systemPrompt) {
      body.system = cacheSystem
        ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
        : systemPrompt
    }
    if (temperature !== undefined) body.temperature = temperature
    if (enableWebSearch) {
      body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]
    }

    const response = await client.post('/settings/ai-providers/proxy/anthropic', body)

    // When web search is active the response content may contain server_tool_use and
    // web_search_tool_result blocks before the final text block — collect all text blocks.
    const contentBlocks: Array<{ type: string; text?: string; name?: string; input?: unknown }> = response.data?.content ?? []
    const textParts = contentBlocks.filter((b) => b.type === 'text').map((b) => b.text ?? '')
    let text = textParts.join('')

    // If Claude stopped on a tool_use block, it invoked one of our *described* plan
    // actions (edit_note, edit_section, …) as though it were a native tool instead of
    // emitting the JSON envelope, so recover the plan from the tool_use block(s).
    // This must NOT be gated on `!text`: when web search is enabled Claude interleaves
    // running commentary ("let me search…", "now I'll add it to the article…") as text
    // blocks, so `text` is non-empty even though the real action lives in a tool_use
    // block — gating on `!text` silently dropped the action. Anthropic emits web_search
    // as `server_tool_use`, so a plain `tool_use` block here is always a misfired action.
    if (response.data?.stop_reason === 'tool_use') {
      const actions = contentBlocks
        .filter((b) => b.type === 'tool_use' && b.input && typeof b.input === 'object')
        .map((b) => {
          const input = { ...(b.input as Record<string, unknown>) }
          if (!input.type && b.name) input.type = b.name
          return input
        })
      if (actions.length) text = JSON.stringify({ actions })
    }

    const full = prefill ? prefill + text : text
    if (response.data?.stop_reason === 'max_tokens') {
      return full + '\n\n---\n*This response was cut off due to length. You can ask me to continue, or request the information in smaller parts.*'
    }
    return full
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

  async generateMetadata(noteContent: string, summaryPrompt: string): Promise<NoteMetadata> {
    const system = `${summaryPrompt}\n\nAlso generate 3–8 short lowercase tags for this note.\n\nReturn a JSON object with fields "summary" (string) and "tags" (string array). Return ONLY the JSON, no other text.`
    const result = await this.complete(noteContent, { systemPrompt: system })
    try {
      return parseMetadataFromAI(result)
    } catch {
      return { tags: [], summary: '' }
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
  constructor(private config: { id: string; model: string }) {}

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
      max_tokens: 16384,
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

  async generateMetadata(noteContent: string, summaryPrompt: string): Promise<NoteMetadata> {
    const system = `${summaryPrompt}\n\nAlso generate 3–8 short lowercase tags for this note.\n\nReturn a JSON object with fields "summary" (string) and "tags" (string array). Return ONLY the JSON, no other text.`
    const result = await this.complete(noteContent, { systemPrompt: system })
    try {
      return parseMetadataFromAI(result)
    } catch {
      return { tags: [], summary: '' }
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
  constructor(private config: { id: string; model: string }) {}

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

  async generateMetadata(noteContent: string, summaryPrompt: string): Promise<NoteMetadata> {
    const system = `${summaryPrompt}\n\nAlso generate 3–8 short lowercase tags for this note.\n\nReturn a JSON object with fields "summary" (string) and "tags" (string array). Return ONLY the JSON, no other text.`
    const result = await this.complete(noteContent, { systemPrompt: system })
    try {
      return parseMetadataFromAI(result)
    } catch {
      return { tags: [], summary: '' }
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
      })
    case 'openai':
    case 'custom':
      return new OpenAIProvider({
        id: provider.id,
        model: provider.model,
      })
    case 'ollama':
      return new OllamaProvider({
        id: provider.id,
        model: provider.model,
      })
    default:
      throw new Error(`Unknown provider type: ${provider.provider_type}`)
  }
}
