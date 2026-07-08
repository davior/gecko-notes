import { useEffect, useState } from 'react'
import { usersApi, type UserMetrics, type UserStorage } from '@/api/users'
import { useAuthStore } from '@/stores/auth'
import UserMetricsPanel from '@/components/settings/UserMetricsPanel'

// Self-serve view of the signed-in user's own account metrics. Reuses the same
// endpoints as the admin UserManager (now self-or-admin guarded) and the shared
// UserMetricsPanel presentation; folder size is fetched on demand.
export default function UserStats() {
  const userId = useAuthStore((s) => s.user?.id)
  const [metrics, setMetrics] = useState<UserMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [storage, setStorage] = useState<UserStorage | null>(null)
  const [storageLoading, setStorageLoading] = useState(false)

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    setLoading(true)
    usersApi.getUserMetrics(userId)
      .then((m) => { if (!cancelled) setMetrics(m) })
      .catch(() => { if (!cancelled) setMetrics(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [userId])

  async function loadStorage() {
    if (!userId) return
    setStorageLoading(true)
    try {
      setStorage(await usersApi.getUserStorage(userId))
    } finally {
      setStorageLoading(false)
    }
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">Stats</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">An overview of your account activity and storage.</p>
      <div className="card p-5">
        <UserMetricsPanel
          metrics={metrics}
          loading={loading}
          storage={storage}
          storageLoading={storageLoading}
          onCalculateStorage={loadStorage}
        />
      </div>
    </div>
  )
}
