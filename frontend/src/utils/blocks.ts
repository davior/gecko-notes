/**
 * Shared BlockNote block utilities for extracting plain text and file URLs.
 * Used by both EditorView (live editor.document) and AIConversationPanel
 * (parsed JSON from fetched notes).
 */

export function extractPlainText(blocks: unknown[]): string {
  if (!blocks) return ''
  try {
    const texts: string[] = []
    function processBlock(block: Record<string, unknown>) {
      const content = block.content
      if (Array.isArray(content)) {
        for (const item of content) {
          if (typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'text') {
            texts.push(String((item as Record<string, unknown>).text ?? ''))
          }
        }
      }
      if (Array.isArray(block.children)) {
        for (const child of block.children) processBlock(child as Record<string, unknown>)
      }
    }
    for (const block of blocks) {
      processBlock(block as Record<string, unknown>)
      texts.push('\n')
    }
    return texts.join('').trim()
  } catch {
    return ''
  }
}

export function extractLinkedFileUrls(blocks: unknown[]): string[] {
  const urls: string[] = []
  function walk(block: Record<string, unknown>) {
    if (block.type === 'image') {
      const url = (block.props as Record<string, unknown>)?.url
      if (typeof url === 'string' && url) urls.push(url)
    }
    if (Array.isArray(block.children)) {
      for (const child of block.children) walk(child as Record<string, unknown>)
    }
  }
  for (const block of blocks) walk(block as Record<string, unknown>)
  return urls
}
