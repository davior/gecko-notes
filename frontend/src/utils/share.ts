import type { Note } from '@/api/notes'

function extractPlainText(contentStr: string): string {
  try {
    const blocks = JSON.parse(contentStr)
    const texts: string[] = []
    function processBlock(block: Record<string, unknown>) {
      const content = block.content
      if (Array.isArray(content)) {
        for (const item of content) {
          if (typeof item === 'object' && item !== null) {
            const typedItem = item as Record<string, unknown>
            if (typedItem.type === 'text' && typeof typedItem.text === 'string') {
              texts.push(typedItem.text)
            }
          }
        }
      }
      const children = block.children
      if (Array.isArray(children)) {
        for (const child of children) {
          if (typeof child === 'object' && child !== null) {
            processBlock(child as Record<string, unknown>)
          }
        }
      }
    }
    for (const block of blocks) {
      processBlock(block)
      texts.push('\n')
    }
    return texts.join('').trim()
  } catch {
    return contentStr
  }
}

function noteSnapshot(note: Note): { title: string; body: string } {
  const body = extractPlainText(note.content)
  return { title: note.title, body }
}

export function shareViaEmail(note: Note): void {
  const { title, body } = noteSnapshot(note)
  let emailBody = body
  if (note.share_token) {
    const viewUrl = `${window.location.origin}/shared/${note.share_token}`
    emailBody = `${body}\n\nView full note: ${viewUrl}`
  }
  const subject = encodeURIComponent(title)
  const bodyEncoded = encodeURIComponent(emailBody)
  window.open(`mailto:?subject=${subject}&body=${bodyEncoded}`)
}

export function shareViaFacebook(note: Note): void {
  if (!note.share_token) {
    window.alert('Share the note first to get a public link')
    return
  }
  const previewUrl = `${window.location.origin}/api/shared/${note.share_token}/preview`
  const encodedUrl = encodeURIComponent(previewUrl)
  window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`, '_blank')
}

export function shareViaTwitter(note: Note): void {
  if (!note.share_token) {
    window.alert('Share the note first to get a public link')
    return
  }
  const previewUrl = `${window.location.origin}/api/shared/${note.share_token}/preview`
  const encodedUrl = encodeURIComponent(previewUrl)
  window.open(`https://twitter.com/intent/tweet?url=${encodedUrl}`, '_blank')
}

// --- Public shared-page sharing -------------------------------------------
// The public viewer (/shared/:token) only knows the URL token + title, not the
// full Note object. These helpers share the OG-rich preview URL so social cards
// render nicely, mirroring shareViaFacebook/shareViaTwitter above.

export function sharedPreviewUrl(token: string): string {
  return `${window.location.origin}/api/shared/${token}/preview`
}

export type ShareNetwork = 'x' | 'facebook' | 'linkedin' | 'email'

export function shareSharedPage(network: ShareNetwork, token: string, title: string): void {
  const u = encodeURIComponent(sharedPreviewUrl(token))
  const t = encodeURIComponent(title || 'Shared note')
  const targets: Record<ShareNetwork, string> = {
    x: `https://twitter.com/intent/tweet?url=${u}&text=${t}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${u}`,
    email: `mailto:?subject=${t}&body=${u}`,
  }
  window.open(targets[network], network === 'email' ? '_self' : '_blank')
}

export async function shareViaSubstack(note: Note): Promise<void> {
  // Convert to markdown-ish format for Substack
  const { title, body } = noteSnapshot(note)
  const md = `# ${title}\n\n${body}`
  await navigator.clipboard.writeText(md)
  window.open('https://substack.com/publish', '_blank')
  // Caller should show a toast: "Content copied — paste into your Substack draft"
}
