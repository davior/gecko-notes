import { useNavigate, useParams, Link, Navigate } from 'react-router-dom'
import { ArrowLeft, Tag, Sparkles, SlidersHorizontal, Users, UserCircle, HardDriveDownload, Palette, Settings, Activity } from 'lucide-react'
import { useSettingsStore } from '@/stores/settings'
import { useAuthStore } from '@/stores/auth'
import CategoryManager from '@/components/settings/CategoryManager'
import UserManager from '@/components/settings/UserManager'
import UserStats from '@/components/settings/UserStats'
import ProfileSettings from '@/components/settings/ProfileSettings'
import DataManager from '@/components/settings/DataManager'
import ThemeManager from '@/components/settings/ThemeManager'
import AIServicesHub from '@/components/settings/AIServicesHub'
import UserAvatar from '@/components/UserAvatar'

const baseTabs = [
  { to: '/settings/profile', label: 'Profile', icon: UserCircle, key: 'profile' },
  { to: '/settings/stats', label: 'Stats', icon: Activity, key: 'stats' },
  { to: '/settings/categories', label: 'Categories', icon: Tag, key: 'categories' },
  { to: '/settings/themes', label: 'Themes', icon: Palette, key: 'themes' },
  { to: '/settings/ai/providers', label: 'AI Services', icon: Sparkles, key: 'ai' },
  { to: '/settings/general', label: 'General', icon: SlidersHorizontal, key: 'general' },
  { to: '/settings/data', label: 'Data', icon: HardDriveDownload, key: 'data' },
]

// Old per-tab routes now live inside the unified AI hub; redirect for compatibility.
const LEGACY_AI_REDIRECTS: Record<string, string> = {
  'ai-providers': 'providers',
  'ai-settings': 'assistant',
  speech: 'speech',
  'image-gen': 'images',
  usage: 'usage',
}

export default function SettingsView() {
  const navigate = useNavigate()
  const { tab, section } = useParams<{ tab?: string; section?: string }>()
  const { defaultSortOrder, updateAppSettings } = useSettingsStore()
  const user = useAuthStore((s) => s.user)

  // Redirect bookmarks/links from the pre-consolidation tab routes into the hub.
  if (tab && tab in LEGACY_AI_REDIRECTS) {
    return <Navigate to={`/settings/ai/${LEGACY_AI_REDIRECTS[tab]}`} replace />
  }

  const isAI = section !== undefined
  const activeKey = isAI ? 'ai' : (tab ?? 'categories')

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
        <Link to="/settings" className="btn-ghost p-2" title="Settings">
          <Settings className="w-5 h-5" />
        </Link>
        <UserAvatar />
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-48 shrink-0 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 py-4">
          <nav className="px-2 space-y-1">
            {tabs.map((t) => {
              const active = activeKey === t.key
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
          <div className={`mx-auto ${isAI ? 'max-w-4xl' : 'max-w-2xl'}`}>
            {isAI && <AIServicesHub section={section as string} />}

            {!isAI && tab === 'categories' && <CategoryManager />}
            {!isAI && tab === 'themes' && <ThemeManager />}
            {!isAI && tab === 'profile' && <ProfileSettings />}
            {!isAI && tab === 'stats' && <UserStats />}
            {!isAI && tab === 'users' && <UserManager />}
            {!isAI && tab === 'data' && <DataManager />}

            {!isAI && tab === 'general' && (
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
