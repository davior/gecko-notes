import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Sparkles, X, Send, FileText, Wand2, PenLine, Tag } from 'lucide-react'
import { useSettingsStore } from '@/stores/settings'

interface Props {
  noteContent: string
  selectedText?: string
  position?: { top: number; left: number }
  onClose: () => void
  onInsert: (text: string) => void
  onReplace: (text: string) => void
  onTagsGenerated: (tags: string[]) => void
  onToast: (msg: string) => void
}

type QuickAction = { label: string; icon: React.ElementType; fn: () => Promise<string> }

export default function AIPanel({ noteContent, selectedText, position, onClose, onInsert, onReplace, onTagsGenerated, onToast }: Props) {
  const aiService = useSettingsStore((s) => s.aiService)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const [customPrompt, setCustomPrompt] = useState('')

  const panelStyle: React.CSSProperties = position
    ? { top: position.top, left: position.left }
    : { bottom: 80, right: 24 }

  const quickActions: QuickAction[] = [
    { label: 'Summarise', icon: FileText, fn: () => aiService!.summarise(selectedText || noteContent) },
    { label: 'Improve Writing', icon: Wand2, fn: () => aiService!.improveWriting(selectedText || noteContent) },
    { label: 'Continue Writing', icon: PenLine, fn: () => aiService!.continueWriting(noteContent) },
    {
      label: 'Generate Tags', icon: Tag,
      fn: async () => {
        const tags = await aiService!.generateTags(noteContent)
        onTagsGenerated(tags)
        return `Suggested tags: ${tags.join(', ')}`
      },
    },
  ]

  async function runAction(action: QuickAction) {
    if (!aiService) return
    setLoading(true); setError(''); setResult('')
    try { setResult(await action.fn()) }
    catch (e) { setError(e instanceof Error ? e.message : 'An error occurred') }
    finally { setLoading(false) }
  }

  async function runCustomPrompt() {
    if (!customPrompt.trim() || !aiService) return
    setLoading(true); setError(''); setResult('')
    try { setResult(await aiService.complete(`${customPrompt}\n\nNote content:\n${noteContent}`)) }
    catch (e) { setError(e instanceof Error ? e.message : 'An error occurred') }
    finally { setLoading(false) }
  }

  async function copyResult() {
    await navigator.clipboard.writeText(result)
    onToast('Copied to clipboard')
  }

  return (
    <div className="fixed z-50 w-80 bg-white rounded-xl border border-gray-200 shadow-xl overflow-hidden" style={panelStyle}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-purple-50">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-blue-600" />
          <span className="text-sm font-semibold text-gray-800">AI Assistant</span>
        </div>
        <button className="text-gray-400 hover:text-gray-600" onClick={onClose}>
          <X className="w-4 h-4" />
        </button>
      </div>

      {!aiService ? (
        <div className="p-4 text-center">
          <p className="text-sm text-gray-500">No AI provider configured.</p>
          <Link to="/settings/ai-providers" className="text-sm text-blue-600 hover:underline mt-1 block">
            Configure AI Provider →
          </Link>
        </div>
      ) : (
        <>
          <div className="p-3 grid grid-cols-2 gap-2">
            {quickActions.map((action) => (
              <button
                key={action.label}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs bg-gray-50 hover:bg-blue-50 hover:text-blue-700 transition-colors text-left border border-gray-100"
                disabled={loading}
                onClick={() => runAction(action)}
              >
                <action.icon className="w-3.5 h-3.5 shrink-0" />
                {action.label}
              </button>
            ))}
          </div>

          <div className="px-3 pb-3">
            <div className="flex gap-2">
              <input
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                type="text"
                placeholder="Custom prompt..."
                className="input text-xs py-1.5"
                onKeyDown={(e) => { if (e.key === 'Enter') runCustomPrompt() }}
              />
              <button
                className="btn-primary px-3 py-1.5 text-xs shrink-0"
                disabled={loading || !customPrompt.trim()}
                onClick={runCustomPrompt}
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {loading && (
            <div className="px-4 pb-3 flex items-center gap-2 text-sm text-gray-500">
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              Thinking...
            </div>
          )}

          {result && !loading && (
            <div className="border-t border-gray-100">
              <div className="px-4 py-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Result</span>
                  <button className="text-xs text-blue-600 hover:underline" onClick={copyResult}>Copy</button>
                </div>
                <p className="text-sm text-gray-800 whitespace-pre-wrap max-h-40 overflow-y-auto">{result}</p>
              </div>
              <div className="px-4 pb-3 flex gap-2">
                <button className="btn-primary text-xs py-1.5 flex-1" onClick={() => onInsert(result)}>Insert at cursor</button>
                <button className="btn-secondary text-xs py-1.5 flex-1" onClick={() => onReplace(result)}>Replace selection</button>
              </div>
            </div>
          )}

          {error && (
            <div className="px-4 pb-3">
              <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2">{error}</p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
