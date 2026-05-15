import { useNavigate, useParams, Link } from 'react-router-dom'
import { useState } from 'react'
import { ArrowLeft, Tag, Cpu, SlidersHorizontal, Sparkles, Users, UserCircle } from 'lucide-react'
import { useSettingsStore } from '@/stores/settings'
import { useAuthStore } from '@/stores/auth'
import { DEFAULT_SUMMARY_PROMPT } from '@/services/ai'
import CategoryManager from '@/components/settings/CategoryManager'
import AIProviderManager from '@/components/settings/AIProviderManager'
import SystemPromptManager from '@/components/settings/SystemPromptManager'
import UserManager from '@/components/settings/UserManager'
import ProfileSettings from '@/components/settings/ProfileSettings'
import UserAvatar from '@/components/UserAvatar'

const baseTabs = [
  { to: '/settings/profile', label: 'Profile', icon: UserCircle, key: 'profile' },
  { to: '/settings/categories', label: 'Categories', icon: Tag, key: 'categories' },
  { to: '/settings/ai-providers', label: 'AI Providers', icon: Cpu, key: 'ai-providers' },
  { to: '/settings/ai-settings', label: 'AI Settings', icon: Sparkles, key: 'ai-settings' },
  { to: '/settings/general', label: 'General', icon: SlidersHorizontal, key: 'general' },
]

export default function SettingsView() {
  const navigate = useNavigate()
  const { tab = 'categories' } = useParams<{ tab: string }>()
  const { defaultSortOrder, updateAppSettings, aiTemperature, aiPrefill, summaryPrompt } = useSettingsStore()
  const [localSummaryPrompt, setLocalSummaryPrompt] = useState<string | null>(null)
  const displaySummaryPrompt = localSummaryPrompt ?? summaryPrompt
  const user = useAuthStore((s) => s.user)

  const tabs = user?.is_admin
    ? [...baseTabs, { to: '/settings/users', label: 'Users', icon: Users, key: 'users' }]
    : baseTabs

  return (
    <div className="flex flex-col h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-3 shrink-0 flex items-center gap-3">
        <button className="btn-ghost p-2" onClick={() => navigate('/notes')}>
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Settings</h1>
        <div className="flex-1" />
        <UserAvatar />
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-48 shrink-0 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 py-4">
          <nav className="px-2 space-y-1">
            {tabs.map((t) => {
              const active = tab === t.key
              return (
                <Link
                  key={t.to}
                  to={t.to}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${active ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 font-medium' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
                >
                  <t.icon className="w-4 h-4" />
                  {t.label}
                </Link>
              )
            })}
          </nav>
        </aside>

        <main className="flex-1 overflow-y-auto p-6">
          <div className="max-w-2xl mx-auto">
            {tab === 'categories' && <CategoryManager />}
            {tab === 'ai-providers' && <AIProviderManager />}

            {tab === 'ai-settings' && (
              <div className="space-y-8">
                <SystemPromptManager />

                <div>
                  <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">Temperature</h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                    Controls randomness. Lower values produce more focused responses; higher values are more creative.
                  </p>
                  <div className="card p-4 space-y-3">
                    <div className="flex items-center gap-4">
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={aiTemperature}
                        className="flex-1 accent-blue-600"
                        onChange={(e) => updateAppSettings({ ai_temperature: parseFloat(e.target.value) })}
                      />
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={aiTemperature}
                        className="input w-20 text-center text-sm"
                        onChange={(e) => {
                          const v = parseFloat(e.target.value)
                          if (!isNaN(v) && v >= 0 && v <= 1) updateAppSettings({ ai_temperature: v })
                        }}
                      />
                    </div>
                    <div className="flex justify-between text-xs text-gray-400">
                      <span>0 — Focused</span>
                      <span>0.8 — Default</span>
                      <span>1 — Creative</span>
                    </div>
                  </div>
                </div>

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
            )}

            {tab === 'profile' && <ProfileSettings />}
            {tab === 'users' && <UserManager />}

            {tab === 'general' && (
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-6">General Settings</h2>
                <div className="card p-5 space-y-4">
                  <div>
                    <label className="label">Default Sort Order</label>
                    <select
                      value={defaultSortOrder}
                      className="input"
                      onChange={(e) => updateAppSettings({ default_sort_order: e.target.value })}
                    >
                      <option value="modified_at">Last Modified</option>
                      <option value="created_at">Created Date</option>
                    </select>
                  </div>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
