import { useNavigate, useParams, Link } from 'react-router-dom'
import { ArrowLeft, Tag, Cpu, SlidersHorizontal } from 'lucide-react'
import { useSettingsStore } from '@/stores/settings'
import CategoryManager from '@/components/settings/CategoryManager'
import AIProviderManager from '@/components/settings/AIProviderManager'

const tabs = [
  { to: '/settings/categories', label: 'Categories', icon: Tag, key: 'categories' },
  { to: '/settings/ai-providers', label: 'AI Providers', icon: Cpu, key: 'ai-providers' },
  { to: '/settings/general', label: 'General', icon: SlidersHorizontal, key: 'general' },
]

export default function SettingsView() {
  const navigate = useNavigate()
  const { tab = 'categories' } = useParams<{ tab: string }>()
  const { defaultSortOrder, updateAppSettings } = useSettingsStore()

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-4 py-3 shrink-0 flex items-center gap-3">
        <button className="btn-ghost p-2" onClick={() => navigate('/notes')}>
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-lg font-semibold text-gray-900">Settings</h1>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-48 shrink-0 bg-white border-r border-gray-200 py-4">
          <nav className="px-2 space-y-1">
            {tabs.map((t) => {
              const active = tab === t.key
              return (
                <Link
                  key={t.to}
                  to={t.to}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${active ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-50'}`}
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
            {tab === 'general' && (
              <div>
                <h2 className="text-lg font-semibold text-gray-900 mb-6">General Settings</h2>
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
