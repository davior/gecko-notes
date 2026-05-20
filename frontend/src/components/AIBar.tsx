import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Send, Sparkles } from 'lucide-react'
import { useSettingsStore } from '@/stores/settings'

interface AIBarProps {
  getNoteContext: () => string
  getSelectedText: () => string
  onResult: (text: string) => void
  placeholder?: string
}

export default function AIBar({
  getNoteContext,
  getSelectedText,
  onResult,
  placeholder = 'Ask AI...',
}: AIBarProps) {
  const aiService = useSettingsStore((s) => s.aiService)

  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit() {
    const trimmed = prompt.trim()
    if (!trimmed || !aiService || loading) return

    setLoading(true)
    setError('')

    try {
      const selectedText = getSelectedText().trim()
      const noteContext = getNoteContext().trim()
      const systemPrompt = selectedText
        ? `You are an AI assistant helping with selected text from a note.\n\nSelected text:\n${selectedText}`
        : noteContext
          ? `You are an AI assistant helping with note content.\n\nNote content:\n${noteContext}`
          : 'You are an AI assistant helping the user.'

      const result = await aiService.complete(trimmed, { systemPrompt })
      onResult(result)
      setPrompt('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to get AI response')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3">
      {!aiService ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4" />
            <span>No AI provider configured</span>
          </div>
          <Link to="/settings/ai-providers" className="text-blue-600 dark:text-blue-400 hover:underline shrink-0">
            Configure
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Sparkles className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void handleSubmit()
                  }
                }}
                type="text"
                placeholder={placeholder}
                className="input pl-9 pr-3 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 dark:placeholder-gray-400"
                disabled={loading}
              />
            </div>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!prompt.trim() || loading}
              className="btn-primary px-3 disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Send AI prompt"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
          {error && (
            <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
          )}
        </div>
      )}
    </div>
  )
}
