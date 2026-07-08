import { useState, useEffect } from 'react'
import { ShieldCheck, ShieldOff, UserX, KeyRound, Loader2, BarChart3 } from 'lucide-react'
import { usersApi, type UserMetrics, type UserStorage } from '@/api/users'
import { useAuthStore } from '@/stores/auth'
import UserMetricsPanel from '@/components/settings/UserMetricsPanel'
import type { User } from '@/api/auth'

export default function UserManager() {
  const currentUser = useAuthStore((s) => s.user)
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)

  const [resetTarget, setResetTarget] = useState<string | null>(null)
  const [resetPw, setResetPw] = useState('')
  const [resetConfirm, setResetConfirm] = useState('')
  const [resetErr, setResetErr] = useState('')
  const [resetting, setResetting] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Per-user metrics are lazily loaded when a card is expanded (avoids N calls on
  // list load); folder size is fetched separately on demand since it walks the disk.
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [metrics, setMetrics] = useState<Record<string, UserMetrics>>({})
  const [metricsLoading, setMetricsLoading] = useState<string | null>(null)
  const [storage, setStorage] = useState<Record<string, UserStorage>>({})
  const [storageLoading, setStorageLoading] = useState<string | null>(null)

  useEffect(() => {
    usersApi.listUsers().then(setUsers).finally(() => setLoading(false))
  }, [])

  async function toggleMetrics(user: User) {
    if (expandedId === user.id) { setExpandedId(null); return }
    setExpandedId(user.id)
    if (!metrics[user.id]) {
      setMetricsLoading(user.id)
      try {
        const m = await usersApi.getUserMetrics(user.id)
        setMetrics((prev) => ({ ...prev, [user.id]: m }))
      } finally {
        setMetricsLoading(null)
      }
    }
  }

  async function loadStorage(userId: string) {
    setStorageLoading(userId)
    try {
      const s = await usersApi.getUserStorage(userId)
      setStorage((prev) => ({ ...prev, [userId]: s }))
    } finally {
      setStorageLoading(null)
    }
  }

  async function toggleAdmin(user: User) {
    const updated = await usersApi.updateUser(user.id, { is_admin: !user.is_admin })
    setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)))
  }

  async function toggleActive(user: User) {
    const updated = await usersApi.updateUser(user.id, { is_active: !user.is_active })
    setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)))
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault()
    setResetErr('')
    if (resetPw !== resetConfirm) { setResetErr('Passwords do not match.'); return }
    if (resetPw.length < 6) { setResetErr('Password must be at least 6 characters.'); return }
    setResetting(true)
    try {
      await usersApi.resetPassword(resetTarget!, resetPw)
      setResetTarget(null)
      setResetPw('')
      setResetConfirm('')
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setResetErr(detail ?? 'Failed to reset password.')
    } finally {
      setResetting(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await usersApi.deleteUser(deleteTarget)
      setUsers((prev) => prev.filter((u) => u.id !== deleteTarget))
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    )
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-6">User Management</h2>

      <div className="space-y-3">
        {users.map((user) => {
          const isSelf = user.id === currentUser?.id
          return (
            <div key={user.id} className="card p-4">
              <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-blue-600 text-white flex items-center justify-center font-semibold text-sm shrink-0 select-none">
                {user.username.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                  {user.username}
                  {isSelf && <span className="ml-2 text-xs text-blue-600 dark:text-blue-400">(you)</span>}
                  {user.is_admin && (
                    <span className="ml-2 text-xs bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 px-1.5 py-0.5 rounded font-medium">Admin</span>
                  )}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{user.email}</p>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                {/* Metrics toggle */}
                <button
                  title={expandedId === user.id ? 'Hide metrics' : 'Show metrics'}
                  className={`p-1.5 rounded-lg transition-colors ${expandedId === user.id ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-300' : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400'}`}
                  onClick={() => toggleMetrics(user)}
                >
                  <BarChart3 className="w-4 h-4" />
                </button>

                {/* Active toggle */}
                <button
                  title={user.is_active ? 'Deactivate user' : 'Activate user'}
                  disabled={isSelf}
                  className={`p-1.5 rounded-lg transition-colors ${isSelf ? 'opacity-30 cursor-not-allowed' : 'hover:bg-gray-100 dark:hover:bg-gray-700'}`}
                  onClick={() => !isSelf && toggleActive(user)}
                >
                  <span className={`text-xs font-medium ${user.is_active ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
                    {user.is_active ? 'Active' : 'Inactive'}
                  </span>
                </button>

                {/* Admin toggle */}
                <button
                  title={user.is_admin ? 'Revoke admin' : 'Grant admin'}
                  disabled={isSelf}
                  className={`p-1.5 rounded-lg transition-colors ${isSelf ? 'opacity-30 cursor-not-allowed' : 'hover:bg-gray-100 dark:hover:bg-gray-700'}`}
                  onClick={() => !isSelf && toggleAdmin(user)}
                >
                  {user.is_admin
                    ? <ShieldOff className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                    : <ShieldCheck className="w-4 h-4 text-gray-400" />}
                </button>

                {/* Reset password */}
                <button
                  title="Reset password"
                  className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                  onClick={() => { setResetTarget(user.id); setResetPw(''); setResetConfirm(''); setResetErr('') }}
                >
                  <KeyRound className="w-4 h-4 text-gray-400" />
                </button>

                {/* Delete */}
                <button
                  title="Delete user"
                  disabled={isSelf}
                  className={`p-1.5 rounded-lg transition-colors ${isSelf ? 'opacity-30 cursor-not-allowed' : 'hover:bg-red-50 dark:hover:bg-red-900/20'}`}
                  onClick={() => !isSelf && setDeleteTarget(user.id)}
                >
                  <UserX className="w-4 h-4 text-gray-400 hover:text-red-500" />
                </button>
              </div>
              </div>

              {expandedId === user.id && (
                <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-700">
                  <UserMetricsPanel
                    metrics={metrics[user.id] ?? null}
                    loading={metricsLoading === user.id}
                    storage={storage[user.id] ?? null}
                    storageLoading={storageLoading === user.id}
                    onCalculateStorage={() => loadStorage(user.id)}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Reset password modal */}
      {resetTarget && (
        <div className="fixed inset-0 bg-black/40 dark:bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card p-6 w-full max-w-sm shadow-xl">
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-4">Reset Password</h3>
            <form onSubmit={handleResetPassword} className="space-y-3">
              <div>
                <label className="label">New Password</label>
                <input type="password" className="input" value={resetPw} onChange={(e) => setResetPw(e.target.value)} required minLength={6} />
              </div>
              <div>
                <label className="label">Confirm Password</label>
                <input type="password" className="input" value={resetConfirm} onChange={(e) => setResetConfirm(e.target.value)} required />
              </div>
              {resetErr && <p className="text-sm text-red-600 dark:text-red-400">{resetErr}</p>}
              <div className="flex gap-2 pt-1">
                <button type="button" className="btn-ghost flex-1" onClick={() => setResetTarget(null)}>Cancel</button>
                <button type="submit" className="btn-primary flex-1" disabled={resetting}>
                  {resetting ? 'Saving…' : 'Reset'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/40 dark:bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="card p-6 w-full max-w-sm shadow-xl">
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">Delete User?</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
              This action is permanent and cannot be undone.
            </p>
            <div className="flex gap-2">
              <button className="btn-ghost flex-1" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button
                className="flex-1 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium transition-colors disabled:opacity-50"
                disabled={deleting}
                onClick={handleDelete}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
