import { useState } from 'react'
import { Heart, Twitter, Facebook, Linkedin, Mail, Link as LinkIcon, Check } from 'lucide-react'
import { sharedApi } from '@/api/shared'
import { shareSharedPage, type ShareNetwork } from '@/utils/share'
import { trackEvent } from '@/utils/analytics'

interface Props {
  token: string
  title: string
  initialLikeCount: number
}

const pillClass =
  'flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 ' +
  'hover:text-gray-900 dark:hover:text-gray-100 border border-gray-200 dark:border-gray-600 ' +
  'hover:bg-gray-50 dark:hover:bg-gray-700 px-2.5 py-1 rounded-full transition-colors'

const likedKey = (token: string) => `gecko_liked_${token}`

export default function SharePageActions({ token, title, initialLikeCount }: Props) {
  const [count, setCount] = useState(initialLikeCount)
  const [liked, setLiked] = useState(() => localStorage.getItem(likedKey(token)) === '1')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  async function toggleLike() {
    if (busy) return
    const next = !liked
    // Optimistic update
    setLiked(next)
    setCount((c) => Math.max(0, c + (next ? 1 : -1)))
    setBusy(true)
    try {
      const res = next ? await sharedApi.like(token) : await sharedApi.unlike(token)
      setCount(res.data.like_count)
      if (next) localStorage.setItem(likedKey(token), '1')
      else localStorage.removeItem(likedKey(token))
      trackEvent(next ? 'like' : 'unlike', { token })
    } catch {
      // Revert on failure
      setLiked(!next)
      setCount((c) => Math.max(0, c + (next ? -1 : 1)))
    } finally {
      setBusy(false)
    }
  }

  function share(network: ShareNetwork) {
    shareSharedPage(network, token, title)
    trackEvent('share', { network, token })
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      trackEvent('share', { network: 'copy', token })
    } catch {
      /* clipboard unavailable */
    }
  }

  const shareButtons: { network: ShareNetwork; Icon: typeof Twitter; label: string }[] = [
    { network: 'x', Icon: Twitter, label: 'Share on X' },
    { network: 'facebook', Icon: Facebook, label: 'Share on Facebook' },
    { network: 'linkedin', Icon: Linkedin, label: 'Share on LinkedIn' },
    { network: 'email', Icon: Mail, label: 'Share via email' },
  ]

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={toggleLike}
        disabled={busy}
        title={liked ? 'Unlike this note' : 'Like this note'}
        aria-label={liked ? 'Unlike this note' : 'Like this note'}
        aria-pressed={liked}
        className={`${pillClass} ${liked ? 'text-red-600 dark:text-red-400 border-red-200 dark:border-red-500/40' : ''}`}
      >
        <Heart className={`w-3.5 h-3.5 ${liked ? 'fill-current' : ''}`} />
        {count}
      </button>

      {shareButtons.map(({ network, Icon, label }) => (
        <button
          key={network}
          type="button"
          onClick={() => share(network)}
          title={label}
          aria-label={label}
          className={pillClass}
        >
          <Icon className="w-3.5 h-3.5" />
        </button>
      ))}

      <button
        type="button"
        onClick={copyLink}
        title="Copy link"
        aria-label="Copy link"
        className={pillClass}
      >
        {copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <LinkIcon className="w-3.5 h-3.5" />}
      </button>
    </div>
  )
}
