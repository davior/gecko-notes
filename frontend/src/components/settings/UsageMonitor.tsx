import { useEffect, useState, useCallback } from 'react'
import { Loader2, Mic, Volume2, Cpu, Image as ImageIcon } from 'lucide-react'
import { settingsApi, type UsageSummary } from '@/api/settings'

const KIND_META: Record<string, { label: string; icon: typeof Mic; color: string }> = {
  tts: { label: 'Text-to-Speech', icon: Volume2, color: 'text-blue-600 dark:text-blue-400' },
  stt: { label: 'Speech-to-Text', icon: Mic, color: 'text-green-600 dark:text-green-400' },
  ai: { label: 'AI Providers', icon: Cpu, color: 'text-purple-600 dark:text-purple-400' },
  image: { label: 'Image Generation', icon: ImageIcon, color: 'text-pink-600 dark:text-pink-400' },
}

const UNIT_LABEL: Record<string, string> = {
  chars: 'characters',
  seconds: 'seconds',
  tokens: 'tokens',
  images: 'images',
}

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
]

function formatNumber(n: number): string {
  return n.toLocaleString()
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export default function UsageMonitor() {
  const [days, setDays] = useState(30)
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (range: number) => {
    setLoading(true)
    setError(null)
    try {
      const data = await settingsApi.getUsage(range)
      setUsage(data)
    } catch {
      setError('Failed to load usage data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(days) }, [days, load])

  const totalsByKind = usage?.totals_by_kind ?? []
  const recent = usage?.recent ?? []

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">Usage</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Monitor your Deepgram TTS, Deepgram STT, AI provider, and image generation API usage.
          </p>
        </div>
        <select
          className="input w-32"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          {RANGES.map((r) => (
            <option key={r.days} value={r.days}>{r.label}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading usage…
        </div>
      ) : error ? (
        <div className="text-sm text-red-500">{error}</div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {['tts', 'stt', 'ai', 'image'].map((kind) => {
              const meta = KIND_META[kind]
              const Icon = meta.icon
              const total = totalsByKind.find((t) => t.kind === kind)
              const units = total?.units ?? 0
              const count = total?.count ?? 0
              const unitType = total?.unit_type || (kind === 'stt' ? 'seconds' : kind === 'ai' ? 'tokens' : kind === 'image' ? 'images' : 'chars')
              return (
                <div key={kind} className="card p-4">
                  <div className={`flex items-center gap-2 mb-2 ${meta.color}`}>
                    <Icon className="w-4 h-4" />
                    <span className="text-sm font-medium">{meta.label}</span>
                  </div>
                  <div className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                    {formatNumber(units)}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {UNIT_LABEL[unitType] ?? unitType} · {formatNumber(count)} request{count === 1 ? '' : 's'}
                  </div>
                </div>
              )
            })}
          </div>

          <div>
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">Recent activity</h3>
            <div className="card overflow-hidden">
              {recent.length === 0 ? (
                <div className="p-4 text-sm text-gray-500 dark:text-gray-400">
                  No usage recorded in the last {days} days.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                      <th className="px-4 py-2 font-medium">When</th>
                      <th className="px-4 py-2 font-medium">Type</th>
                      <th className="px-4 py-2 font-medium">Model</th>
                      <th className="px-4 py-2 font-medium text-right">Usage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((e, i) => {
                      const meta = KIND_META[e.kind]
                      return (
                        <tr key={i} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                          <td className="px-4 py-2 text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatTimestamp(e.created_at)}</td>
                          <td className="px-4 py-2 text-gray-700 dark:text-gray-300">{meta?.label ?? e.kind}</td>
                          <td className="px-4 py-2 text-gray-500 dark:text-gray-400">{e.model || '—'}</td>
                          <td className="px-4 py-2 text-right text-gray-700 dark:text-gray-300 whitespace-nowrap">
                            {formatNumber(e.units)} {UNIT_LABEL[e.unit_type] ?? e.unit_type}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
