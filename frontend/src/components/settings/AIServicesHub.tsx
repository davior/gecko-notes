import { NavLink } from 'react-router-dom'
import { Cpu, Sparkles, Mic, Image as ImageIcon, BarChart3, Database } from 'lucide-react'
import AIProviderManager from '@/components/settings/AIProviderManager'
import AssistantSettings from '@/components/settings/AssistantSettings'
import SpeechSettings from '@/components/settings/SpeechSettings'
import ImageGenSettings from '@/components/settings/ImageGenSettings'
import UsageDashboard from '@/components/settings/UsageDashboard'
import ModelCatalogManager from '@/components/settings/ModelCatalogManager'
import { useAuthStore } from '@/stores/auth'

const BASE_SUBTABS = [
  { key: 'providers', label: 'Providers', icon: Cpu },
  { key: 'assistant', label: 'Assistant', icon: Sparkles },
  { key: 'speech', label: 'Speech', icon: Mic },
  { key: 'images', label: 'Images', icon: ImageIcon },
  { key: 'usage', label: 'Usage', icon: BarChart3 },
] as const

// Unified AI hub: the five formerly-separate AI settings tabs, laid out as
// horizontal sub-tabs. Each body is the existing component, re-hosted unchanged.
// A 6th tab (Model Catalog) is added for admins only.
export default function AIServicesHub({ section }: { section: string }) {
  const isAdmin = useAuthStore((s) => s.user?.is_admin) ?? false
  const SUBTABS = isAdmin
    ? [...BASE_SUBTABS, { key: 'model-catalog' as const, label: 'Model Catalog', icon: Database }]
    : BASE_SUBTABS
  const active = SUBTABS.some((t) => t.key === section) ? section : 'providers'

  return (
    <div className="space-y-6">
      <div className="border-b border-gray-200 dark:border-gray-700">
        <nav className="flex gap-1 -mb-px overflow-x-auto">
          {SUBTABS.map((t) => {
            const isActive = active === t.key
            return (
              <NavLink
                key={t.key}
                to={`/settings/ai/${t.key}`}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-sm border-b-2 whitespace-nowrap transition-colors ${
                  isActive
                    ? 'border-blue-600 text-blue-700 dark:text-blue-400 font-medium'
                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                }`}
              >
                <t.icon className="w-4 h-4" />
                {t.label}
              </NavLink>
            )
          })}
        </nav>
      </div>

      <div>
        {active === 'providers' && <AIProviderManager />}
        {active === 'assistant' && <AssistantSettings />}
        {active === 'speech' && <SpeechSettings />}
        {active === 'images' && <ImageGenSettings />}
        {active === 'usage' && <UsageDashboard />}
        {active === 'model-catalog' && isAdmin && <ModelCatalogManager />}
      </div>
    </div>
  )
}
