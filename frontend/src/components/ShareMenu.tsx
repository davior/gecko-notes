import { createPortal } from 'react-dom'
import { Share2, Mail, ChevronDown } from 'lucide-react'
import type { Note } from '@/api/notes'
import { shareViaEmail, shareViaFacebook, shareViaTwitter, shareViaSubstack } from '@/utils/share'
import { useDropdown } from '@/hooks/useDropdown'

interface Props {
  note: Note
  onToast: (msg: string) => void
}

export default function ShareMenu({ note, onToast }: Props) {
  const { open, setOpen, triggerRef, dropdownRef, style } = useDropdown('right')

  const items = [
    { label: 'Share via Email', icon: Mail, action: () => shareViaEmail(note) },
    { label: 'Share on Facebook', icon: Share2, action: () => shareViaFacebook(note) },
    { label: 'Share on X (Twitter)', icon: Share2, action: () => shareViaTwitter(note) },
    {
      label: 'Share on Substack', icon: Share2,
      action: async () => { await shareViaSubstack(note); onToast('Content copied — paste into your Substack draft') },
    },
  ]

  async function handleShare(action: () => Promise<void> | void) {
    setOpen(false)
    await action()
  }

  return (
    <div className="relative" ref={triggerRef}>
      <button className="btn-ghost gap-1 text-sm" onClick={() => setOpen((o) => !o)}>
        <Share2 className="w-4 h-4" />
        Share
        <ChevronDown className="w-3 h-3" />
      </button>

      {open && createPortal(
        <div ref={dropdownRef} className="z-50 w-52 bg-white rounded-xl border border-gray-200 shadow-lg overflow-hidden" style={style}>
          <div className="p-1">
            {items.map((item) => (
              <button
                key={item.label}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-gray-50 transition-colors text-left"
                onClick={() => handleShare(item.action)}
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
