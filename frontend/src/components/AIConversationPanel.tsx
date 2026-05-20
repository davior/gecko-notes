import { useState, useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import { Sparkles, X, Send, Copy, Check, Plus, Pencil } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useSettingsStore } from '@/stores/settings'

export interface ConversationMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

interface AIConversationPanelProps {
  isOpen: boolean
  onToggle: () => void
  getNoteContext: () => string
  conversation: ConversationMessage[]
  onConversationChange: (messages: ConversationMessage[]) => void
  onAddToNote: (text: string) => Promise<void>
}

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function Spinner() {
  return (
    <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  )
}

export default function AIConversationPanel({
  isOpen,
  onToggle,
  getNoteContext,
  conversation,
  onConversationChange,
  onAddToNote,
}: AIConversationPanelProps) {
  const aiService = useSettingsStore((s) => s.aiService)

  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const editRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (isOpen) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [conversation, loading, isOpen])

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto'
      inputRef.current.style.height = `${inputRef.current.scrollHeight}px`
    }
  }, [input])

  useEffect(() => {
    if (editRef.current) {
      editRef.current.style.height = 'auto'
      editRef.current.style.height = `${editRef.current.scrollHeight}px`
    }
  }, [editText])

  async function handleSend(userContent: string, priorMessages: ConversationMessage[]) {
    if (!userContent.trim() || !aiService || loading) return
    setError('')

    const userMsg: ConversationMessage = {
      id: uid(),
      role: 'user',
      content: userContent.trim(),
      timestamp: new Date().toISOString(),
    }
    const withUser = [...priorMessages, userMsg]
    onConversationChange(withUser)
    setInput('')
    setLoading(true)

    try {
      const transcript = priorMessages
        .map((m) => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
        .join('\n\n')
      const fullPrompt = transcript
        ? `${transcript}\n\nHuman: ${userContent.trim()}`
        : userContent.trim()

      const noteContext = getNoteContext()
      const systemPrompt = noteContext
        ? `You are an AI assistant helping the user with their note.\n\nNote content:\n${noteContext}`
        : 'You are an AI assistant helping the user.'

      const result = await aiService.complete(fullPrompt, { systemPrompt })

      const assistantMsg: ConversationMessage = {
        id: uid(),
        role: 'assistant',
        content: result,
        timestamp: new Date().toISOString(),
      }
      onConversationChange([...withUser, assistantMsg])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'An error occurred')
      // Roll back to prior messages (remove the user message we optimistically added)
      onConversationChange(priorMessages)
    } finally {
      setLoading(false)
    }
  }

  function handleEdit(idx: number) {
    const priorMessages = conversation.slice(0, idx)
    setEditingId(null)
    setEditText('')
    void handleSend(editText, priorMessages)
  }

  function handleCopy(content: string, id: string) {
    void navigator.clipboard.writeText(content).then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
    })
  }

  function handleClear() {
    onConversationChange([])
  }

  if (!isOpen) {
    return (
      <div className="shrink-0 flex sm:flex-col items-center justify-center no-print">
        <button
          onClick={onToggle}
          className="sm:h-full w-full sm:w-9 flex sm:flex-col items-center justify-center gap-2 px-3 sm:px-0 py-2 sm:py-0 border-t sm:border-t-0 sm:border-l border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 hover:bg-blue-50 dark:hover:bg-blue-900/20 hover:text-blue-500 text-gray-400 transition-colors"
          title="Open AI Chat"
        >
          <Sparkles className="w-4 h-4" />
          <span className="text-xs sm:hidden">AI Chat</span>
          <span className="hidden sm:block text-xs font-medium tracking-widest" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
            AI Chat
          </span>
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col w-full sm:w-80 xl:w-96 shrink-0 border-t sm:border-t-0 sm:border-l border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-900 max-h-72 sm:max-h-none no-print">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-gray-700">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-gray-800 dark:text-gray-100">
          <Sparkles className="w-4 h-4 text-blue-500" />
          AI Assistant
        </div>
        <div className="flex items-center gap-2">
          {conversation.length > 0 && (
            <button
              onClick={handleClear}
              className="text-xs text-gray-400 hover:text-red-500 transition-colors"
            >
              Clear
            </button>
          )}
          <button onClick={onToggle} className="btn-ghost p-1" title="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4 min-h-0">
        {!aiService && (
          <div className="text-center py-8 text-sm text-gray-400 space-y-2">
            <Sparkles className="w-8 h-8 mx-auto text-gray-300" />
            <p>No AI provider configured.</p>
            <Link to="/settings/ai-providers" className="text-blue-500 hover:underline text-xs">
              Configure AI →
            </Link>
          </div>
        )}

        {aiService && conversation.length === 0 && !loading && (
          <div className="text-center py-8 text-sm text-gray-400 space-y-1">
            <Sparkles className="w-8 h-8 mx-auto text-gray-300" />
            <p>Ask anything about this note.</p>
          </div>
        )}

        {conversation.map((msg, idx) =>
          msg.role === 'user' ? (
            <div key={msg.id} className="flex flex-col items-end gap-1">
              {editingId === msg.id ? (
                <div className="w-full space-y-1">
                  <textarea
                    ref={editRef}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEdit(idx) }
                      if (e.key === 'Escape') { setEditingId(null); setEditText('') }
                    }}
                    rows={1}
                    className="w-full resize-none input text-sm py-1.5 max-h-28 overflow-y-auto"
                    autoFocus
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
                      onClick={() => { setEditingId(null); setEditText('') }}
                    >
                      Cancel
                    </button>
                    <button
                      className="text-xs px-2.5 py-1 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-colors"
                      disabled={!editText.trim() || loading}
                      onClick={() => handleEdit(idx)}
                    >
                      Send
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="max-w-[85%] bg-blue-600 text-white rounded-2xl rounded-tr-sm px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words">
                    {msg.content}
                  </div>
                  <button
                    className="text-gray-300 hover:text-gray-500 dark:hover:text-gray-400 transition-colors p-0.5"
                    title="Edit message"
                    onClick={() => { setEditingId(msg.id); setEditText(msg.content) }}
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                </>
              )}
            </div>
          ) : (
            <div key={msg.id} className="flex flex-col items-start gap-1">
              <div className="max-w-[85%] bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 rounded-2xl rounded-tl-sm px-3 py-2 text-sm leading-relaxed break-words prose prose-sm dark:prose-invert max-w-none">
                <ReactMarkdown
                  components={{
                    p: ({ children }) => <p className="mb-1 last:mb-0">{children}</p>,
                    ul: ({ children }) => <ul className="list-disc list-inside space-y-0.5 my-1">{children}</ul>,
                    ol: ({ children }) => <ol className="list-decimal list-inside space-y-0.5 my-1">{children}</ol>,
                    code: ({ children }) => <code className="bg-gray-200 dark:bg-gray-700 rounded px-1 font-mono text-xs">{children}</code>,
                    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                  }}
                >
                  {msg.content}
                </ReactMarkdown>
              </div>
              <div className="flex items-center gap-1">
                <button
                  className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors px-1.5 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
                  title="Copy response"
                  onClick={() => handleCopy(msg.content, msg.id)}
                >
                  {copiedId === msg.id ? (
                    <><Check className="w-3 h-3 text-green-500" /><span className="text-green-500">Copied</span></>
                  ) : (
                    <><Copy className="w-3 h-3" />Copy</>
                  )}
                </button>
                <button
                  className="flex items-center gap-1 text-xs text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors px-1.5 py-0.5 rounded hover:bg-blue-50 dark:hover:bg-blue-900/20"
                  title="Add to note"
                  onClick={() => void onAddToNote(msg.content)}
                >
                  <Plus className="w-3 h-3" />Add to note
                </button>
              </div>
            </div>
          )
        )}

        {loading && (
          <div className="flex items-start gap-2">
            <div className="bg-gray-100 dark:bg-gray-800 rounded-2xl rounded-tl-sm px-3 py-2.5 flex items-center gap-2 text-gray-400 text-sm">
              <Spinner />
              Thinking…
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-center justify-between bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2 text-xs text-red-600 dark:text-red-400">
            <span>{error}</span>
            <button onClick={() => setError('')} className="ml-2 hover:text-red-800 dark:hover:text-red-300">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      {aiService && (
        <div className="shrink-0 border-t border-gray-100 dark:border-gray-700 p-2">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleSend(input, conversation)
                }
              }}
              placeholder="Ask about this note…"
              rows={1}
              className="flex-1 resize-none input text-sm py-1.5 max-h-28 overflow-y-auto"
              disabled={loading}
            />
            <button
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
              disabled={loading || !input.trim()}
              onClick={() => void handleSend(input, conversation)}
              type="button"
            >
              {loading ? <Spinner /> : <Send className="w-3.5 h-3.5" />}
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">Shift+Enter for new line</p>
        </div>
      )}
    </div>
  )
}
