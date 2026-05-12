import { useState, useEffect, useRef } from 'react'
import { Send, ChevronDown } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useSettingsStore } from '@/stores/settings'

type ContextMode = 'whole' | 'selected' | 'none'

interface AIBarProps {
  getNoteContext: () => string
  getSelectedText: () => string
  onResult: (text: string) => void
  placeholder?: string
}

export default function AIBar({ getNoteContext, getSelectedText, onResult, placeholder }: AIBarProps) {
  const aiService = useSettingsStore((s) => s.aiService)
  const activeSystemPrompt = useSettingsStore((s) => s.activeSystemPrompt)
  const aiTemperature = useSettingsStore((s) => s.aiTemperature)
  const aiPrefill = useSettingsStore((s) => s.aiPrefill)

  const [prompt, setPrompt] = useState('')
  const [context, setContext] = useState<ContextMode>('whole')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showContextMenu, setShowContextMenu] = useState(false)
  const autoSwitchedRef = useRef(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-switch context when text is selected/deselected
  useEffect(() => {
    const sel = getSelectedText()
    if (sel && context !== 'selected') {
      setContext('selected')
      autoSwitchedRef.current = true
    } else if (!sel && autoSwitchedRef.current && context === 'selected') {
      setContext('whole')
      autoSwitchedRef.current = false
    }
  })

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowContextMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  async function handleSubmit() {
    if (!prompt.trim() || !aiService || loading) return
    setLoading(true)
    setError('')

    try {
      let contextText = ''
      if (context === 'whole') {
        contextText = getNoteContext()
      } else if (context === 'selected') {
        contextText = getSelectedText()
      }

      const fullPrompt = contextText
        ? `${prompt.trim()}\n\nContext:\n${contextText}`
        : prompt.trim()

      const result = await aiService.complete(fullPrompt, {
        systemPrompt: activeSystemPrompt?.content,
        temperature: aiTemperature,
        prefill: aiPrefill || undefined,
      })

      onResult(result)
      setPrompt('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }

  const contextLabels: Record<ContextMode, string> = {
    whole: 'Whole note',
    selected: 'Selection',
    none: 'No context',
  }

  const hasSelection = Boolean(getSelectedText())

  if (!aiService) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-xs text-gray-400 dark:text-gray-500 border-t border-gray-100 dark:border-gray-700">
        <span>No AI provider configured.</span>
        <Link to="/settings/ai-providers" className="text-blue-500 hover:underline">
          Configure →
        </Link>
      </div>
    )
  }

  return (
    <div className="border-t border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2">
      {error && (
        <p className="text-xs text-red-600 dark:text-red-400 mb-1.5 px-1">{error}</p>
      )}
      <div className="flex items-center gap-2">
        {/* Context selector */}
        <div className="relative shrink-0" ref={menuRef}>
          <button
            className="flex items-center gap-1 text-xs px-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-400 transition-colors whitespace-nowrap"
            onClick={() => setShowContextMenu((v) => !v)}
            type="button"
          >
            {contextLabels[context]}
            <ChevronDown className="w-3 h-3 opacity-60" />
          </button>
          {showContextMenu && (
            <div className="absolute bottom-full mb-1 left-0 z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg overflow-hidden min-w-[130px]">
              {(['whole', 'selected', 'none'] as ContextMode[]).map((mode) => (
                <button
                  key={mode}
                  className={`w-full text-left text-xs px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors ${context === mode ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-700 dark:text-gray-300'} ${mode === 'selected' && !hasSelection ? 'opacity-40 cursor-not-allowed' : ''}`}
                  disabled={mode === 'selected' && !hasSelection}
                  onClick={() => {
                    if (mode === 'selected' && !hasSelection) return
                    setContext(mode)
                    autoSwitchedRef.current = false
                    setShowContextMenu(false)
                  }}
                >
                  {contextLabels[mode]}
                  {mode === 'selected' && hasSelection && (
                    <span className="ml-1 text-blue-500">•</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Prompt input */}
        <input
          ref={inputRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSubmit() } }}
          type="text"
          placeholder={placeholder ?? 'Ask AI…'}
          className="flex-1 text-sm px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-blue-400 dark:focus:border-blue-500 transition-colors"
          disabled={loading}
        />

        {/* Send button */}
        <button
          className="shrink-0 flex items-center justify-center w-8 h-8 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
          disabled={loading || !prompt.trim()}
          onClick={handleSubmit}
          type="button"
        >
          {loading ? (
            <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
          ) : (
            <Send className="w-3.5 h-3.5" />
          )}
        </button>
      </div>
    </div>
  )
}
