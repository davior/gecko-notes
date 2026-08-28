import { useState } from 'react'
import { useSettingsStore } from '@/stores/settings'
import { DEFAULT_SUMMARY_PROMPT } from '@/services/ai'
import SystemPromptManager from '@/components/settings/SystemPromptManager'
import WebSearchSettings from '@/components/settings/WebSearchSettings'

export default function AssistantSettings() {
  const { updateAppSettings, aiPrefill, summaryPrompt } = useSettingsStore()
  const [localSummaryPrompt, setLocalSummaryPrompt] = useState<string | null>(null)
  const displaySummaryPrompt = localSummaryPrompt ?? summaryPrompt

  return (
    <div className="space-y-8">
      <SystemPromptManager />

      <WebSearchSettings />

      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">Prefilled Assistant Response</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          The AI will be made to start every response with this text, steering tone and format. Leave empty to disable.
        </p>
        <div className="card p-4">
          <input
            type="text"
            className="input"
            placeholder='e.g. "Looking at this from all angles —"'
            value={aiPrefill}
            onChange={(e) => updateAppSettings({ ai_prefill: e.target.value })}
          />
          {aiPrefill && (
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
              Responses will begin: <em className="text-gray-600 dark:text-gray-300">&ldquo;{aiPrefill}&rdquo;</em>
            </p>
          )}
        </div>
      </div>

      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">Summary Prompt</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Instructions given to the AI when generating a note summary. The default prompt produces dense, factual summaries optimised for RAG retrieval.
        </p>
        <div className="card p-4 space-y-3">
          <textarea
            className="input min-h-[160px] resize-y font-mono text-xs"
            value={displaySummaryPrompt}
            onChange={(e) => setLocalSummaryPrompt(e.target.value)}
            onBlur={() => {
              if (localSummaryPrompt !== null) {
                void updateAppSettings({ summary_prompt: localSummaryPrompt || DEFAULT_SUMMARY_PROMPT })
                setLocalSummaryPrompt(null)
              }
            }}
          />
          {displaySummaryPrompt !== DEFAULT_SUMMARY_PROMPT && (
            <button
              className="text-xs text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 underline"
              onClick={() => {
                setLocalSummaryPrompt(null)
                void updateAppSettings({ summary_prompt: DEFAULT_SUMMARY_PROMPT })
              }}
            >
              Reset to default
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
