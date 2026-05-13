import { Link } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'

export default function UserAvatar() {
  const user = useAuthStore((s) => s.user)
  if (!user) return null

  const initial = user.username.charAt(0).toUpperCase()

  return (
    <Link to="/profile" title={`Profile: ${user.username}`} className="shrink-0">
      {user.avatar_url ? (
        <img
          src={user.avatar_url}
          alt={user.username}
          className="w-8 h-8 rounded-full object-cover ring-2 ring-gray-200 dark:ring-gray-600 hover:ring-blue-400 transition-all"
        />
      ) : (
        <div className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-semibold ring-2 ring-gray-200 dark:ring-gray-600 hover:ring-blue-400 transition-all select-none">
          {initial}
        </div>
      )}
    </Link>
  )
}
