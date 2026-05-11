import type { AIProvider } from '@/api/settings'
import apiClient from '@/api/client'

export interface AIService {
  complete(prompt: string, systemPrompt?: string): Promise<string>
  generateTags(noteContent: string): Promise<string[]>
  summarise(noteContent: string): Promise<string>
  improveWriting(text: string): Promise<string>
  continueWriting(context: string): Promise<string>
  testConnection(): Promise<boolean>
}

const TAG_GENERATION_PROMPT = `You are a tagging assistant. Analyse the following note content and return between 3 and 8 short, relevant tags as a JSON array of lowercase strings. Return ONLY the JSON array, no other text.

Content:
{note_content}`

// All providers proxy through the backend to avoid CORS restrictions.

class BackendProxyProvider implements AIService {
  async complete(prompt: string, systemPrompt?: string): Promise<string> {
    const response = await apiClient.post<{ text: string }>('/settings/ai-complete', {
      prompt,
      system_prompt: systemPrompt,
    })
    return response.data.text
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

  async summarise(noteContent: string): Promise<string> {
    return this.complete(
      `Please summarise the following note content concisely:\n\n${noteContent}`,
      'You are a helpful writing assistant. Provide clear, concise summaries.'
    )
  }

  async improveWriting(text: string): Promise<string> {
    return this.complete(
      `Please improve the following text for clarity and style, keeping the same meaning:\n\n${text}`,
      "You are a skilled editor. Improve writing while preserving the author's voice and meaning."
    )
  }

  async continueWriting(context: string): Promise<string> {
    return this.complete(
      `Please continue writing from where this text leaves off:\n\n${context}`,
      'You are a helpful writing assistant. Continue the text naturally and coherently.'
    )
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.complete('Hi', 'Respond with just "ok"')
      return true
    } catch {
      return false
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function createAIService(_provider: AIProvider): AIService {
  return new BackendProxyProvider()
}
