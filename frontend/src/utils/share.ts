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
  const subject = encodeURIComponent(title)
  const bodyEncoded = encodeURIComponent(body)
  window.open(`mailto:?subject=${subject}&body=${bodyEncoded}`)
}

export function shareViaFacebook(note: Note): void {
  const { title, body } = noteSnapshot(note)
  const quote = encodeURIComponent(`${title}\n${body}`)
  window.open(`https://www.facebook.com/sharer/sharer.php?u=&quote=${quote}`, '_blank')
}

export function shareViaTwitter(note: Note): void {
  const { title, body } = noteSnapshot(note)
  const MAX_CHARS = 270
  let text = `${title}\n${body}`
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS - 3) + '...'
  }
  const encoded = encodeURIComponent(text)
  window.open(`https://twitter.com/intent/tweet?text=${encoded}`, '_blank')
}

export async function shareViaSubstack(note: Note): Promise<void> {
  // Convert to markdown-ish format for Substack
  const { title, body } = noteSnapshot(note)
  const md = `# ${title}\n\n${body}`
  await navigator.clipboard.writeText(md)
  window.open('https://substack.com/publish', '_blank')
  // Caller should show a toast: "Content copied — paste into your Substack draft"
}
