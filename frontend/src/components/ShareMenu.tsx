import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Share2, Mail, ChevronDown, Globe, Link, GlobeLock } from 'lucide-react'
import type { Note } from '@/api/notes'
import { shareViaEmail, shareViaFacebook, shareViaTwitter, shareViaSubstack } from '@/utils/share'
import { useDropdown } from '@/hooks/useDropdown'
import { useNotesStore } from '@/stores/notes'

interface Props {
  note: Note
  onToast: (msg: string) => void
  onUpdate?: (note: Note) => void
}

export default function ShareMenu({ note, onToast, onUpdate }: Props) {
  const { open, setOpen, triggerRef, dropdownRef, style } = useDropdown('right')
  const { shareNote, unshareNote } = useNotesStore()
  const [working, setWorking] = useState(false)

  const shareUrl = note.share_token ? `${window.location.origin}/shared/${note.share_token}` : null

  async function handleEnableSharing() {
    setWorking(true)
    try {
      const updated = await shareNote(note.id)
      onUpdate?.(updated)
      const url = `${window.location.origin}/shared/${updated.share_token}`
      await navigator.clipboard.writeText(url)
      onToast('Share link copied to clipboard')
      setOpen(false)
    } catch {
      onToast('Failed to enable sharing')
    } finally {
      setWorking(false)
    }
  }

  async function handleCopyLink() {
    if (!shareUrl) return
    await navigator.clipboard.writeText(shareUrl)
    onToast('Share link copied to clipboard')
    setOpen(false)
  }

  async function handleDisableSharing() {
    setWorking(true)
    try {
      const updated = await unshareNote(note.id)
      onUpdate?.(updated)
      onToast('Sharing disabled')
      setOpen(false)
    } catch {
      onToast('Failed to disable sharing')
    } finally {
      setWorking(false)
    }
  }

  const socialItems = [
    { label: 'Share via Email', icon: Mail, action: () => shareViaEmail(note) },
    { label: 'Share on Facebook', icon: Share2, action: () => shareViaFacebook(note) },
    { label: 'Share on X (Twitter)', icon: Share2, action: () => shareViaTwitter(note) },
    {
      label: 'Share on Substack', icon: Share2,
      action: async () => { await shareViaSubstack(note); onToast('Content copied — paste into your Substack draft') },
    },
  ]

  async function handleSocial(action: () => Promise<void> | void) {
    setOpen(false)
    await action()
  }

  return (
    <div className="relative" ref={triggerRef}>
      <button
        className={`btn-ghost gap-1 text-sm ${note.is_shared ? 'text-green-600' : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        {note.is_shared ? <Globe className="w-4 h-4" /> : <Share2 className="w-4 h-4" />}
        Share
        <ChevronDown className="w-3 h-3" />
      </button>

      {open && createPortal(
        <div ref={dropdownRef} className="z-50 w-60 bg-white rounded-xl border border-gray-200 shadow-lg overflow-hidden" style={style}>
          <div className="p-1">
            {/* Public sharing section */}
            {note.is_shared ? (
              <>
                <div className="px-3 py-1.5 flex items-center gap-1.5">
                  <Globe className="w-3.5 h-3.5 text-green-500" />
                  <span className="text-xs font-medium text-green-600">Shared publicly</span>
                </div>
                <button
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-gray-50 transition-colors text-left"
                  onClick={handleCopyLink}
                >
                  <Link className="w-4 h-4 text-gray-500" />
                  <span>Copy link</span>
                </button>
                <button
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-red-50 hover:text-red-600 transition-colors text-left"
                  disabled={working}
                  onClick={handleDisableSharing}
                >
                  <GlobeLock className="w-4 h-4 text-gray-400" />
                  <span>Disable sharing</span>
                </button>
              </>
            ) : (
              <button
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-green-50 hover:text-green-700 transition-colors text-left"
                disabled={working}
                onClick={handleEnableSharing}
              >
                <Globe className="w-4 h-4 text-gray-500" />
                <span>{working ? 'Enabling...' : 'Share publicly'}</span>
              </button>
            )}

            <div className="my-1 border-t border-gray-100" />

            {/* Social share options */}
            {socialItems.map((item) => (
              <button
                key={item.label}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-gray-50 transition-colors text-left"
                onClick={() => handleSocial(item.action)}
              >
                <item.icon className="w-4 h-4 text-gray-500" />
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
