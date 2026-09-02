/**
 * A minimal structural view of the BlockNote editor.
 *
 * The AI panel needs one to turn the open document into Markdown for the model's
 * context. That is the only direction still done in the browser — Markdown back into
 * blocks now happens server-side, so a plan can be applied without an editor at all
 * (app/blocks/markdown_blocks.py). Declared as a method rather than an arrow property
 * so the real editor's more specifically typed parameters stay assignable.
 */
export interface MarkdownEditor {
  blocksToMarkdownLossy(blocks?: unknown[]): string
}

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

/**
 * Repoint image blocks at newly stored copies, given a remote-URL -> /media-URL map.
 * Used by the URL importer after downloading a page's images: the note is built from
 * the page's own image URLs, then swapped over to the local ones. URLs with no entry
 * in the map (a download that failed) are left pointing at the original.
 *
 * Mutates in place and returns the same array — the caller owns freshly parsed blocks.
 */
export function rewriteImageUrls(blocks: unknown[], mapping: Record<string, string>): unknown[] {
  if (Object.keys(mapping).length === 0) return blocks
  function walk(block: Record<string, unknown>) {
    if (block.type === 'image') {
      const props = block.props as Record<string, unknown> | undefined
      const url = props?.url
      if (typeof url === 'string' && mapping[url]) props!.url = mapping[url]
    }
    if (Array.isArray(block.children)) {
      for (const child of block.children) walk(child as Record<string, unknown>)
    }
  }
  for (const block of blocks) walk(block as Record<string, unknown>)
  return blocks
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
