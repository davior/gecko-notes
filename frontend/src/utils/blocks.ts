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

/**
 * Flatten blocks into a list of { id, text } pairs (one per block that carries an
 * id), used to anchor annotations: the AI references a block by a text snippet and
 * the executor resolves it back to a block id. Nested children are included.
 */
export function extractBlockTexts(blocks: unknown[]): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = []
  function blockText(block: Record<string, unknown>): string {
    const parts: string[] = []
    const content = block.content
    if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'text') {
          parts.push(String((item as Record<string, unknown>).text ?? ''))
        }
      }
    }
    return parts.join('')
  }
  function walk(block: Record<string, unknown>) {
    const id = block.id
    if (typeof id === 'string') out.push({ id, text: blockText(block) })
    if (Array.isArray(block.children)) {
      for (const child of block.children) walk(child as Record<string, unknown>)
    }
  }
  for (const block of blocks) walk(block as Record<string, unknown>)
  return out
}

export interface OutlineHeading {
  /** Block id — matches the rendered block's DOM `data-id`, used to scroll to it. */
  id: string
  text: string
  /** Heading level 1–6. */
  level: number
}

/**
 * Walk blocks and collect heading blocks as a flat, document-order list of
 * { id, text, level }. Nested headings (inside a block's children) are included.
 * Derive this from `editor.document` rather than raw saved JSON so the ids line
 * up with the live DOM `data-id` attributes.
 */
export function extractHeadings(blocks: unknown[]): OutlineHeading[] {
  const out: OutlineHeading[] = []
  function inlineText(content: unknown): string {
    if (!Array.isArray(content)) return ''
    let s = ''
    for (const item of content) {
      if (typeof item !== 'object' || item === null) continue
      const rec = item as Record<string, unknown>
      if (rec.type === 'text') s += String(rec.text ?? '')
      else if (Array.isArray(rec.content)) s += inlineText(rec.content) // links, etc.
    }
    return s
  }
  function walk(block: Record<string, unknown>) {
    if (block.type === 'heading' && typeof block.id === 'string') {
      const levelRaw = (block.props as Record<string, unknown> | undefined)?.level
      const level = typeof levelRaw === 'number' ? levelRaw : Number(levelRaw) || 1
      out.push({ id: block.id, level, text: inlineText(block.content).trim() })
    }
    if (Array.isArray(block.children)) {
      for (const child of block.children) walk(child as Record<string, unknown>)
    }
  }
  for (const block of blocks) walk(block as Record<string, unknown>)
  return out
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
