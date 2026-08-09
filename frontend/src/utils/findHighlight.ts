/**
 * Paints find/replace matches onto the rendered note using the CSS Custom Highlight
 * API — every match gets a soft highlight, the current one a stronger colour. This
 * highlights arbitrary text ranges WITHOUT mutating the editor DOM (no wrapper spans)
 * or touching ProseMirror, so it can't disturb BlockNote.
 *
 * Ranges come from the model matches (utils/findReplace `computeMatches`), whose
 * `start`/`end` are block-relative offsets over the block's inline text. We rebuild
 * the same offset space from the block's `.bn-inline-content` DOM text nodes and turn
 * each match into a DOM `Range`, so the painted matches always agree with the "N of M"
 * counter and navigation.
 *
 * Styling lives in main.css: `::highlight(find-match)` / `::highlight(find-current)`,
 * and a `.find-current-block` fallback used when the API is unavailable.
 */
import type { FindMatch } from '@/utils/findReplace'

const MATCH_HL = 'find-match'
const CURRENT_HL = 'find-current'
const FALLBACK_CLASS = 'find-current-block'

function apiSupported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'
}

function nearestBlockId(el: Element | null | undefined): string | null {
  return el?.closest('[data-id]')?.getAttribute('data-id') ?? null
}

function blockEl(scroller: HTMLElement, blockId: string): HTMLElement | null {
  return scroller.querySelector<HTMLElement>(`[data-id="${CSS.escape(blockId)}"]`)
}

interface NodeSpan { node: Text; start: number; end: number }

/**
 * Cumulative text-node offset map for a block: walk the `.bn-inline-content` elements
 * that belong to this block (nearest `[data-id]` ancestor is the block — excludes
 * nested child blocks and non-content bits like list markers), concatenating their
 * text nodes. Falls back to the block element itself if the class is ever absent.
 */
function buildOffsetMap(el: HTMLElement, blockId: string): NodeSpan[] {
  const contents = Array.from(el.querySelectorAll<HTMLElement>('.bn-inline-content'))
    .filter((c) => nearestBlockId(c) === blockId)
  const scopes: HTMLElement[] = contents.length ? contents : [el]
  const spans: NodeSpan[] = []
  let offset = 0
  for (const scope of scopes) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      if (nearestBlockId(node.parentElement) !== blockId) continue // skip nested child-block text
      const text = (node as Text).data
      if (!text) continue
      spans.push({ node: node as Text, start: offset, end: offset + text.length })
      offset += text.length
    }
  }
  return spans
}

function locate(spans: NodeSpan[], offset: number): { node: Text; offset: number } | null {
  for (const span of spans) {
    if (offset >= span.start && offset <= span.end) return { node: span.node, offset: offset - span.start }
  }
  const last = spans[spans.length - 1]
  return last ? { node: last.node, offset: last.node.data.length } : null // clamp defensively
}

function rangeFromOffsets(spans: NodeSpan[], start: number, end: number): Range | null {
  const s = locate(spans, start)
  const e = locate(spans, end)
  if (!s || !e) return null
  const range = document.createRange()
  range.setStart(s.node, s.offset)
  range.setEnd(e.node, e.offset)
  return range
}

/** Remove all find highlights (both the API highlights and the fallback class). */
export function clearFindHighlights(): void {
  if (apiSupported()) {
    CSS.highlights.delete(MATCH_HL)
    CSS.highlights.delete(CURRENT_HL)
  }
  document.querySelectorAll(`.${FALLBACK_CLASS}`).forEach((el) => el.classList.remove(FALLBACK_CLASS))
}

/**
 * Paint `matches` inside `scroller`: all matches under `find-match`, and the one at
 * `currentIndex` under `find-current` (higher priority so it wins where they meet).
 * When the Custom Highlight API is unavailable, marks just the current match's block
 * with `.find-current-block` instead.
 */
export function paintFindHighlights(scroller: HTMLElement | null, matches: FindMatch[], currentIndex: number): void {
  clearFindHighlights()
  if (!scroller || matches.length === 0) return

  if (!apiSupported()) {
    const cur = matches[currentIndex]
    if (cur) blockEl(scroller, cur.blockId)?.classList.add(FALLBACK_CLASS)
    return
  }

  // Group match indices by block so each block's DOM is walked once.
  const byBlock = new Map<string, number[]>()
  matches.forEach((m, i) => {
    const list = byBlock.get(m.blockId)
    if (list) list.push(i)
    else byBlock.set(m.blockId, [i])
  })

  const matchRanges: Range[] = []
  let currentRange: Range | null = null

  for (const [blockId, indices] of byBlock) {
    const el = blockEl(scroller, blockId)
    if (!el) continue
    const spans = buildOffsetMap(el, blockId)
    if (spans.length === 0) continue
    for (const i of indices) {
      const range = rangeFromOffsets(spans, matches[i].start, matches[i].end)
      if (!range) continue
      if (i === currentIndex) currentRange = range
      else matchRanges.push(range)
    }
  }

  if (matchRanges.length) CSS.highlights.set(MATCH_HL, new Highlight(...matchRanges))
  if (currentRange) {
    const highlight = new Highlight(currentRange)
    highlight.priority = 1
    CSS.highlights.set(CURRENT_HL, highlight)
  }
}
