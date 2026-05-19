import { createPortal } from 'react-dom'
import { Bot, Check } from 'lucide-react'
import { useSettingsStore } from '@/stores/settings'
import { useDropdown } from '@/hooks/useDropdown'

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  ollama: 'Ollama',
  custom: 'Custom',
}

export default function AIProviderPicker() {
  const { aiProviders, activeProvider, activateAIProvider } = useSettingsStore()
  const { open, setOpen, triggerRef, dropdownRef, style } = useDropdown('right')

  const enabledProviders = aiProviders.filter((p) => p.enabled)

  return (
    <div ref={triggerRef}>
      <button
        className={`btn-ghost p-2 ${activeProvider ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400'}`}
        title={activeProvider ? `AI: ${activeProvider.name}` : 'No AI provider active'}
        onClick={() => setOpen((o) => !o)}
      >
        <Bot className="w-5 h-5" />
      </button>

      {open && createPortal(
        <div
          ref={dropdownRef}
          className="z-50 w-56 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-lg overflow-hidden"
          style={style}
        >
          <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700">
            <p className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide">AI Provider</p>
          </div>

          <div className="overflow-y-auto max-h-60 p-1">
            {enabledProviders.length === 0 ? (
              <p className="px-3 py-2 text-sm text-gray-400 dark:text-gray-500">No providers configured.</p>
            ) : (
              enabledProviders.map((p) => {
                const isActive = p.id === activeProvider?.id
                return (
                  <button
                    key={p.id}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left ${
                      isActive
                        ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 font-medium'
                        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                    }`}
                    onClick={() => { void activateAIProvider(p.id); setOpen(false) }}
                  >
                    <Bot className="w-4 h-4 shrink-0" />
                    <span className="truncate flex-1">{p.name}</span>
                    <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">
                      {PROVIDER_LABELS[p.provider_type] ?? p.provider_type}
                    </span>
                    {isActive && <Check className="w-3.5 h-3.5 shrink-0" />}
                  </button>
                )
              })
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
