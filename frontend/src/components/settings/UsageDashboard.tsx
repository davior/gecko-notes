import { useEffect, useMemo, useState, useCallback } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, Cell, LabelList,
} from 'recharts'
import { Loader2, Mic, Volume2, Cpu, Globe, Image as ImageIcon } from 'lucide-react'
import { settingsApi, type UsageSummary } from '@/api/settings'
import { useSettingsStore } from '@/stores/settings'
import { formatCost } from '@/api/imageGen'

const KIND_ORDER = ['tts', 'stt', 'ai', 'image', 'search'] as const
type Kind = (typeof KIND_ORDER)[number]

const KIND_META: Record<Kind, { label: string; icon: typeof Mic; color: string }> = {
  tts: { label: 'Text-to-Speech', icon: Volume2, color: 'text-blue-600 dark:text-blue-400' },
  stt: { label: 'Speech-to-Text', icon: Mic, color: 'text-emerald-600 dark:text-emerald-400' },
  ai: { label: 'AI Providers', icon: Cpu, color: 'text-amber-600 dark:text-amber-400' },
  image: { label: 'Image Generation', icon: ImageIcon, color: 'text-green-700 dark:text-green-500' },
  search: { label: 'Web Search', icon: Globe, color: 'text-indigo-600 dark:text-indigo-400' },
}

// Validated categorical slots 1–5 (see dataviz skill references/palette.md), light + dark.
const KIND_HUE: Record<'light' | 'dark', Record<Kind, string>> = {
  light: { tts: '#2a78d6', stt: '#1baf7a', ai: '#eda100', image: '#008300', search: '#4a3aa7' },
  dark: { tts: '#3987e5', stt: '#199e70', ai: '#c98500', image: '#008300', search: '#9085e9' },
}

// Full 8-slot categorical ramp for the by-provider bars (also reused by
// UserMetricsPanel's storage-by-filetype donut, so keep this as the one
// source of truth rather than redefining it there).
export const CATEGORICAL: Record<'light' | 'dark', string[]> = {
  light: ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834'],
  dark: ['#3987e5', '#199e70', '#c98500', '#008300', '#9085e9', '#e66767', '#d55181', '#d95926'],
}

const UNIT_LABEL: Record<string, string> = {
  chars: 'characters', seconds: 'seconds', tokens: 'tokens', images: 'images', searches: 'searches',
}

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic', openai: 'OpenAI', ollama: 'Ollama (local)', 'fal.ai': 'fal.ai',
  ai: 'AI (legacy)', tts: 'Speech (legacy)', stt: 'Speech (legacy)', image: 'Images (legacy)',
  duckduckgo: 'DuckDuckGo', brave: 'Brave Search', tavily: 'Tavily', searxng: 'SearXNG',
}

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
]

const fmtNum = (n: number) => n.toLocaleString()

function fmtTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function fmtDay(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function UsageDashboard() {
  const [days, setDays] = useState(30)
  const [metric, setMetric] = useState<'count' | 'cost'>('count')
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const isDark = useSettingsStore((s) => s.theme) === 'dark'

  const load = useCallback(async (range: number) => {
    setLoading(true)
    setError(null)
    try {
      setUsage(await settingsApi.getUsage(range))
    } catch {
      setError('Failed to load usage data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(days) }, [days, load])

  const chrome = isDark
    ? { grid: '#2c2c2a', axis: '#383835', text: '#c3c2b7', muted: '#898781', surface: '#1a1a19', ring: 'rgba(255,255,255,0.10)' }
    : { grid: '#e1e0d9', axis: '#c3c2b7', text: '#52514e', muted: '#898781', surface: '#fcfcfb', ring: 'rgba(11,11,11,0.10)' }

  const totalsByKind = usage?.totals_by_kind ?? []
  const byProvider = usage?.by_provider ?? []
  const recent = usage?.recent ?? []

  // Pivot the daily series into one row per date with a column per kind.
  const trendData = useMemo(() => {
    const rows = new Map<string, Record<string, number | string>>()
    for (const d of usage?.by_day ?? []) {
      const row = rows.get(d.date) ?? { date: d.date }
      row[d.kind] = ((row[d.kind] as number) ?? 0) + (metric === 'cost' ? d.cost : d.count)
      rows.set(d.date, row)
    }
    return Array.from(rows.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)))
  }, [usage, metric])

  const activeKinds = KIND_ORDER.filter((k) => trendData.some((r) => (r[k] as number) > 0))

  const providerData = byProvider
    .filter((p) => (p.cost ?? 0) > 0)
    .map((p) => ({ ...p, label: PROVIDER_LABEL[p.provider] ?? p.provider }))
  const anyEstimated = providerData.some((p) => p.estimated)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">Usage</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Monitor your text-to-speech, speech-to-text, AI provider, and image generation API usage.
          </p>
        </div>
        <select className="input w-32" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {RANGES.map((r) => <option key={r.days} value={r.days}>{r.label}</option>)}
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
          {/* Summary cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {KIND_ORDER.map((kind) => {
              const meta = KIND_META[kind]
              const Icon = meta.icon
              const total = totalsByKind.find((t) => t.kind === kind)
              const units = total?.units ?? 0
              const count = total?.count ?? 0
              const unitType = total?.unit_type || (kind === 'stt' ? 'seconds' : kind === 'ai' ? 'tokens' : kind === 'image' ? 'images' : kind === 'search' ? 'searches' : 'chars')
              return (
                <div key={kind} className="card p-4">
                  <div className={`flex items-center gap-2 mb-2 ${meta.color}`}>
                    <Icon className="w-4 h-4" />
                    <span className="text-sm font-medium">{meta.label}</span>
                  </div>
                  <div className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{fmtNum(units)}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {UNIT_LABEL[unitType] ?? unitType} · {fmtNum(count)} request{count === 1 ? '' : 's'}
                  </div>
                  {total?.cost ? (
                    <div className="text-xs font-medium text-gray-600 dark:text-gray-300 mt-0.5">
                      {formatCost(total.cost, total.currency)}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>

          {/* Trend chart */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Usage over time</h3>
              <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden text-xs">
                {(['count', 'cost'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMetric(m)}
                    className={`px-3 py-1.5 ${metric === m ? 'bg-blue-600 text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
                  >
                    {m === 'count' ? 'Requests' : 'Est. cost'}
                  </button>
                ))}
              </div>
            </div>
            <div className="card p-4">
              {activeKinds.length === 0 ? (
                <div className="text-sm text-gray-500 dark:text-gray-400 py-8 text-center">
                  {metric === 'cost' ? 'No cost recorded in this range.' : 'No usage recorded in this range.'}
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={trendData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={chrome.grid} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" tickFormatter={fmtDay} tick={{ fill: chrome.muted, fontSize: 11 }} axisLine={{ stroke: chrome.axis }} tickLine={false} />
                    <YAxis
                      tick={{ fill: chrome.muted, fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      width={metric === 'cost' ? 52 : 40}
                      tickFormatter={(v: number) => (metric === 'cost' ? formatCost(v) : fmtNum(v))}
                    />
                    <Tooltip
                      contentStyle={{ background: chrome.surface, border: `1px solid ${chrome.ring}`, borderRadius: 8, fontSize: 12, color: chrome.text }}
                      labelFormatter={(l) => fmtDay(String(l))}
                      formatter={(value, name) => {
                        const v = Number(value)
                        return [metric === 'cost' ? formatCost(v) : fmtNum(v), KIND_META[name as Kind]?.label ?? String(name)]
                      }}
                      cursor={{ fill: chrome.ring }}
                    />
                    <Legend
                      formatter={(v) => <span style={{ color: chrome.text, fontSize: 12 }}>{KIND_META[v as Kind]?.label ?? v}</span>}
                    />
                    {activeKinds.map((k, i) => (
                      <Bar
                        key={k}
                        dataKey={k}
                        stackId="usage"
                        fill={KIND_HUE[isDark ? 'dark' : 'light'][k]}
                        radius={i === activeKinds.length - 1 ? [3, 3, 0, 0] : undefined}
                        maxBarSize={48}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Cost breakdown by provider */}
          <div>
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">Cost by provider</h3>
            <div className="card p-4">
              {providerData.length === 0 ? (
                <div className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center">
                  No cost recorded yet. LLM costs are list-price estimates; fal.ai cost is billed exactly.
                </div>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={Math.max(120, providerData.length * 48)}>
                    <BarChart data={providerData} layout="vertical" margin={{ top: 4, right: 56, left: 8, bottom: 4 }}>
                      <CartesianGrid stroke={chrome.grid} strokeDasharray="3 3" horizontal={false} />
                      <XAxis type="number" tick={{ fill: chrome.muted, fontSize: 11 }} axisLine={{ stroke: chrome.axis }} tickLine={false} tickFormatter={(v: number) => formatCost(v)} />
                      <YAxis type="category" dataKey="label" width={120} tick={{ fill: chrome.text, fontSize: 12 }} axisLine={false} tickLine={false} />
                      <Tooltip
                        contentStyle={{ background: chrome.surface, border: `1px solid ${chrome.ring}`, borderRadius: 8, fontSize: 12, color: chrome.text }}
                        formatter={(value) => [formatCost(Number(value)), 'Cost']}
                        cursor={{ fill: chrome.ring }}
                      />
                      <Bar dataKey="cost" radius={[0, 3, 3, 0]} maxBarSize={28}>
                        {providerData.map((p, i) => (
                          <Cell key={p.provider} fill={CATEGORICAL[isDark ? 'dark' : 'light'][i % 8]} />
                        ))}
                        <LabelList dataKey="cost" position="right" formatter={(v) => formatCost(Number(v))} style={{ fill: chrome.text, fontSize: 11 }} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                  {anyEstimated && (
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
                      Costs marked for LLM providers are list-price estimates; fal.ai cost is billed exactly.
                    </p>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Recent activity */}
          <div>
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">Recent activity</h3>
            <div className="card overflow-hidden">
              {recent.length === 0 ? (
                <div className="p-4 text-sm text-gray-500 dark:text-gray-400">No usage recorded in the last {days} days.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                        <th className="px-4 py-2 font-medium">When</th>
                        <th className="px-4 py-2 font-medium">Type</th>
                        <th className="px-4 py-2 font-medium">Provider</th>
                        <th className="px-4 py-2 font-medium">Model</th>
                        <th className="px-4 py-2 font-medium text-right">Usage</th>
                        <th className="px-4 py-2 font-medium text-right">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.map((e, i) => {
                        const meta = KIND_META[e.kind as Kind]
                        return (
                          <tr key={i} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                            <td className="px-4 py-2 text-gray-500 dark:text-gray-400 whitespace-nowrap">{fmtTimestamp(e.created_at)}</td>
                            <td className="px-4 py-2 text-gray-700 dark:text-gray-300">{meta?.label ?? e.kind}</td>
                            <td className="px-4 py-2 text-gray-500 dark:text-gray-400">{e.provider ? (PROVIDER_LABEL[e.provider] ?? e.provider) : '—'}</td>
                            <td className="px-4 py-2 text-gray-500 dark:text-gray-400">{e.model || '—'}</td>
                            <td className="px-4 py-2 text-right text-gray-700 dark:text-gray-300 whitespace-nowrap">
                              {fmtNum(e.units)} {UNIT_LABEL[e.unit_type] ?? e.unit_type}
                            </td>
                            <td className="px-4 py-2 text-right text-gray-500 dark:text-gray-400 whitespace-nowrap">
                              {e.cost != null ? (
                                <>{formatCost(e.cost, e.currency)}{e.cost_estimated ? <span className="text-gray-400"> est.</span> : null}</>
                              ) : '—'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
