import type { AIProvider } from '@/api/settings'
import client from '@/api/client'

export interface AICompleteOptions {
  systemPrompt?: string
  temperature?: number
  prefill?: string
}

export interface AIService {
  complete(prompt: string, options?: AICompleteOptions): Promise<string>
  generateTags(noteContent: string): Promise<string[]>
  generateSummary(noteContent: string, prompt: string): Promise<string>
  summarise(noteContent: string): Promise<string>
  improveWriting(text: string): Promise<string>
  continueWriting(context: string): Promise<string>
  testConnection(): Promise<boolean>
}

const TAG_GENERATION_PROMPT = `You are a tagging assistant. Analyse the following note content and return between 3 and 8 short, relevant tags as a JSON array of lowercase strings. Return ONLY the JSON array, no other text.

Content:
{note_content}`

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
    const { systemPrompt, temperature, prefill } = options
    const messages: { role: string; content: string }[] = [{ role: 'user', content: prompt }]
    if (prefill) {
      messages.push({ role: 'assistant', content: prefill })
    }

    const body: Record<string, unknown> = {
      provider_id: this.config.id,
      model: this.config.model,
      max_tokens: 2048,
      messages,
    }
    if (systemPrompt) body.system = systemPrompt
    if (temperature !== undefined) body.temperature = temperature

    const response = await client.post('/settings/ai-providers/proxy/anthropic', body)
    const text = response.data?.content?.[0]?.text ?? ''
    return prefill ? prefill + text : text
  }

  async generateTags(noteContent: string): Promise<string[]> {
    const prompt = TAG_GENERATION_PROMPT.replace('{note_content}', noteContent)
    const result = await this.complete(prompt)
    try {
      return JSON.parse(result)
    } catch {
      return []
    }
  }

  async generateSummary(noteContent: string, prompt: string): Promise<string> {
    return this.complete(noteContent, { systemPrompt: prompt })
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
    const { systemPrompt, temperature, prefill } = options
    const messages: { role: string; content: string }[] = []
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
    messages.push({ role: 'user', content: prompt })
    if (prefill) messages.push({ role: 'assistant', content: prefill })

    const body: Record<string, unknown> = {
      provider_id: this.config.id,
      model: this.config.model,
      max_tokens: 2048,
      messages,
    }
    if (temperature !== undefined) body.temperature = temperature

    const response = await client.post('/settings/ai-providers/proxy/openai', body)
    const text = response.data?.choices?.[0]?.message?.content ?? ''
    return prefill ? prefill + text : text
  }

  async generateTags(noteContent: string): Promise<string[]> {
    const prompt = TAG_GENERATION_PROMPT.replace('{note_content}', noteContent)
    const result = await this.complete(prompt)
    try {
      return JSON.parse(result)
    } catch {
      return []
    }
  }

  async generateSummary(noteContent: string, prompt: string): Promise<string> {
    return this.complete(noteContent, { systemPrompt: prompt })
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
    const { systemPrompt, temperature, prefill } = options
    const messages: { role: string; content: string }[] = []
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
    messages.push({ role: 'user', content: prompt })
    if (prefill) messages.push({ role: 'assistant', content: prefill })

    const body: Record<string, unknown> = {
      provider_id: this.config.id,
      model: this.config.model,
      messages,
    }
    if (temperature !== undefined) body.temperature = temperature

    const response = await client.post('/settings/ai-providers/proxy/ollama', body)
    const text = response.data?.message?.content ?? ''
    return prefill ? prefill + text : text
  }

  async generateTags(noteContent: string): Promise<string[]> {
    const prompt = TAG_GENERATION_PROMPT.replace('{note_content}', noteContent)
    const result = await this.complete(prompt)
    try {
      return JSON.parse(result)
    } catch {
      return []
    }
  }

  async generateSummary(noteContent: string, prompt: string): Promise<string> {
    return this.complete(noteContent, { systemPrompt: prompt })
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
