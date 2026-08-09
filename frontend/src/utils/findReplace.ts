/**
 * Find & Replace over a BlockNote document.
 *
 * The note body is a BlockNote block tree (see EditorView), not a string, so a
 * naive text replace is impossible. This module walks the inline content of each
 * block — the `type:'text'` runs, the text inside inline links, and table cells —
 * matching/replacing against it while preserving each run's inline styles
 * (bold/italic/colour/…). It powers the FindReplaceBar UI.
 *
 * Scope (v1):
 * - A match never crosses a link, table-cell or block boundary (each such inline
 *   array is searched on its own), but it DOES span differently-styled text runs
 *   within one array (e.g. "hel" + bold "lo").
 * - Custom blocks (childNote/diagram/noteReference/audio/video) keep their text in
 *   `props` — ids, titles, mermaid source, URLs — not prose, and are intentionally
 *   not searched (editing them would corrupt structured data).
 */
import type { BlockNoteEditor } from '@blocknote/core'

/* eslint-disable @typescript-eslint/no-explicit-any -- BlockNote's block and
   inline-content shapes are deeply generic; like DocumentOutline.tsx we walk them
   with loose typing and validate shapes at runtime. */

export type FindMode = 'text' | 'regex'

export interface FindOptions {
  query: string
  mode: FindMode
  caseSensitive: boolean
  /** Text mode only — wraps the (escaped) query in `\b…\b`. Ignored for regex. */
  wholeWord: boolean
}

/**
 * One occurrence, in document order. Only the block id is needed: to scroll to and
 * flash the block, and to target a single replace; the array length drives the
 * "N of M" readout. (Block-level flash is the chosen navigation UX, so a sub-block
 * offset isn't required.)
 */
export interface FindMatch {
  blockId: string
}

interface TextRun { type: 'text'; text: string; styles: any }
interface SegmentMatch { start: number; end: number; groups: RegExpExecArray }

/**
 * Build the matcher for either mode. Always global; case-insensitive unless
 * `caseSensitive`. Text mode escapes regex metacharacters and, when `wholeWord`,
 * wraps the query in word boundaries. Returns `{regex:null,error:null}` for an
 * empty query and `{regex:null,error}` (never throws) for an invalid regex.
 */
export function buildRegex(opts: FindOptions): { regex: RegExp | null; error: string | null } {
  if (!opts.query) return { regex: null, error: null }
  const flags = 'g' + (opts.caseSensitive ? '' : 'i')
  try {
    if (opts.mode === 'regex') return { regex: new RegExp(opts.query, flags), error: null }
    let src = opts.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (opts.wholeWord) src = `\\b${src}\\b`
    return { regex: new RegExp(src, flags), error: null }
  } catch (e) {
    return { regex: null, error: (e as Error).message }
  }
}

/**
 * Expand `$1`–`$99`, `$&` and `$$` backreferences in a regex-mode replacement. In
 * text mode the replacement is inserted literally, so a literal "$1" stays "$1".
 */
export function expandTemplate(template: string, groups: RegExpExecArray | null, mode: FindMode): string {
  if (mode !== 'regex' || !groups) return template
  return template.replace(/\$(\$|&|\d{1,2})/g, (whole, token: string) => {
    if (token === '$') return '$'
    if (token === '&') return groups[0]
    const n = Number(token)
    return n < groups.length ? (groups[n] ?? '') : whole
  })
}

/**
 * Non-empty, non-overlapping matches of `regex` within one segment's text,
 * left-to-right. Zero-length matches (e.g. `a*`, `\b`, lookarounds) are skipped and
 * stepped over so the scan can't loop forever. Callers must pass a global-flagged
 * regex (buildRegex guarantees it); lastIndex is reset here so the object is reusable.
 */
export function findSegmentMatches(text: string, regex: RegExp): SegmentMatch[] {
  const out: SegmentMatch[] = []
  regex.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = regex.exec(text)) !== null) {
    if (m[0].length === 0) { regex.lastIndex++; continue }
    out.push({ start: m.index, end: m.index + m[0].length, groups: m })
  }
  return out
}

/**
 * Replace [start,end) across a segment's run list while preserving styles: the
 * prefix keeps the first covered run's style, the suffix the last covered run's,
 * and the inserted replacement inherits the first covered run's style. Fully
 * covered middle runs are dropped; empty pieces are never emitted.
 */
export function spliceRuns(runs: TextRun[], start: number, end: number, replacement: string): TextRun[] {
  if (runs.length === 0) return runs
  const bounds: { s: number; e: number }[] = []
  let off = 0
  for (const r of runs) { bounds.push({ s: off, e: off + r.text.length }); off += r.text.length }
  let first = bounds.findIndex((b) => start >= b.s && start < b.e)
  if (first === -1) first = runs.length - 1
  let last = bounds.findIndex((b) => end > b.s && end <= b.e)
  if (last === -1) last = runs.length - 1
  const out: TextRun[] = []
  for (let i = 0; i < first; i++) out.push(runs[i])
  const prefix = runs[first].text.slice(0, start - bounds[first].s)
  const suffix = runs[last].text.slice(end - bounds[last].s)
  if (prefix) out.push({ type: 'text', text: prefix, styles: runs[first].styles })
  if (replacement) out.push({ type: 'text', text: replacement, styles: runs[first].styles })
  if (suffix) out.push({ type: 'text', text: suffix, styles: runs[last].styles })
  for (let i = last + 1; i < runs.length; i++) out.push(runs[i])
  return out
}

/**
 * The inline-content arrays of a block, in document order: a normal block's
 * `content`, or every cell of a table (row-major). A cell is either an inline
 * array or a `{content:[…]}` object (both forms occur — see EditorView's table
 * handling). Nested links are handled by the per-array walkers, not here.
 */
function eachBlockArray(block: any, fn: (arr: any[]) => void): void {
  const content = block?.content
  if (Array.isArray(content)) { fn(content); return }
  if (block?.type === 'table' && content && Array.isArray(content.rows)) {
    for (const row of content.rows) {
      const cells = row?.cells
      if (!Array.isArray(cells)) continue
      for (const cell of cells) {
        const arr = Array.isArray(cell) ? cell : cell?.content
        if (Array.isArray(arr)) fn(arr)
      }
    }
  }
}

/**
 * Read-only walk of one inline array, invoking `onMatch` once per occurrence in
 * document order, recursing into link labels at their position. Mirrors
 * transformInArray's traversal exactly so occurrence indices line up between the
 * two (replace-current relies on that alignment).
 */
function collectInArray(arr: any[], regex: RegExp, onMatch: () => void): void {
  let i = 0
  while (i < arr.length) {
    const item = arr[i]
    if (item?.type === 'text') {
      let text = ''
      while (i < arr.length && arr[i]?.type === 'text') { text += String(arr[i].text ?? ''); i++ }
      const n = findSegmentMatches(text, regex).length
      for (let k = 0; k < n; k++) onMatch()
    } else {
      if (item?.type === 'link' && Array.isArray(item.content)) collectInArray(item.content, regex, onMatch)
      i++
    }
  }
}

/**
 * Every match in the document, in order. Walks each block and its children
 * depth-first (mirroring extractBlockTexts/extractHeadings in utils/blocks.ts).
 * Returns the regex `error` (if any) so the UI can surface an invalid pattern.
 */
export function computeMatches(blocks: any[], opts: FindOptions): { matches: FindMatch[]; error: string | null } {
  const { regex, error } = buildRegex(opts)
  if (!regex) return { matches: [], error }
  const matches: FindMatch[] = []
  const walk = (block: any) => {
    if (typeof block?.id === 'string') {
      const id = block.id
      eachBlockArray(block, (arr) => collectInArray(arr, regex, () => matches.push({ blockId: id })))
    }
    if (Array.isArray(block?.children)) for (const c of block.children) walk(c)
  }
  for (const b of blocks) walk(b)
  return { matches, error: null }
}

/**
 * Mutating walk of one inline array: replace chosen matches in place, preserving
 * styles, recursing into link labels. `decide(globalIndex)` picks which occurrences
 * to replace and `counter` threads the running occurrence index (document order)
 * across the whole block, so replace-current can target the Nth. Matches within a
 * segment are applied right-to-left so earlier offsets stay valid; after a splice
 * the cursor advances past the rewritten runs. Returns whether anything changed.
 */
function transformInArray(
  arr: any[], regex: RegExp, template: string, mode: FindMode,
  decide: (i: number) => boolean, counter: { n: number },
): boolean {
  let changed = false
  let i = 0
  while (i < arr.length) {
    const item = arr[i]
    if (item?.type === 'text') {
      const startIdx = i
      const runs: TextRun[] = []
      while (i < arr.length && arr[i]?.type === 'text') {
        runs.push({ type: 'text', text: String(arr[i].text ?? ''), styles: arr[i].styles ?? {} }); i++
      }
      const text = runs.map((r) => r.text).join('')
      const segMatches = findSegmentMatches(text, regex)
      const chosen: SegmentMatch[] = []
      for (const sm of segMatches) { if (decide(counter.n++)) chosen.push(sm) }
      if (chosen.length) {
        let newRuns = runs
        for (let k = chosen.length - 1; k >= 0; k--) {
          const sm = chosen[k]
          newRuns = spliceRuns(newRuns, sm.start, sm.end, expandTemplate(template, sm.groups, mode))
        }
        arr.splice(startIdx, runs.length, ...newRuns)
        changed = true
        i = startIdx + newRuns.length
      }
    } else {
      if (item?.type === 'link' && Array.isArray(item.content)) {
        if (transformInArray(item.content, regex, template, mode, decide, counter)) changed = true
      }
      i++
    }
  }
  return changed
}

/** Apply `transformInArray` across all of a block's inline arrays with a fresh
 *  per-block occurrence counter, returning [changed, matchesSeen]. */
function transformBlock(
  block: any, regex: RegExp, template: string, mode: FindMode, decide: (i: number) => boolean,
): { changed: boolean; seen: number } {
  const counter = { n: 0 }
  let changed = false
  eachBlockArray(block, (arr) => {
    if (transformInArray(arr, regex, template, mode, decide, counter)) changed = true
  })
  return { changed, seen: counter.n }
}

function jsonClone<T>(v: T): T {
  return v == null ? v : (JSON.parse(JSON.stringify(v)) as T)
}

/**
 * Replace every match in the document. Operates on a JSON clone of each block so
 * the live editor state is never mutated in place, then writes each changed block
 * back with a single `updateBlock`. Runs inside `editor.transact` when available so
 * the whole operation is one undo step. Works off a fresh scan of each segment (not
 * a stale match list), and never re-scans replaced text, so `a`→`aa` terminates.
 * Returns the number of occurrences replaced.
 */
export function replaceAll(editor: BlockNoteEditor<any, any, any>, opts: FindOptions, template: string): number {
  const { regex } = buildRegex(opts)
  if (!regex) return 0
  let replaced = 0
  const run = () => {
    const walk = (block: any) => {
      if (typeof block?.id === 'string') {
        const clone = jsonClone(editor.getBlock(block.id))
        if (clone) {
          const { changed, seen } = transformBlock(clone, regex, template, opts.mode, () => true)
          if (changed) { replaced += seen; editor.updateBlock(block.id, { content: (clone as any).content }) }
        }
      }
      if (Array.isArray(block?.children)) for (const c of block.children) walk(c)
    }
    for (const b of editor.document) walk(b)
  }
  const transact = (editor as any).transact
  if (typeof transact === 'function') transact.call(editor, run)
  else run()
  return replaced
}

/**
 * Replace a single occurrence — the one at `currentIndex` in `matches` (the list
 * from computeMatches). The occurrence's position within its own block is derived
 * from the list, then the block clone is transformed with a decider that fires only
 * on that Nth occurrence. Returns whether a replacement was made.
 */
export function replaceCurrent(
  editor: BlockNoteEditor<any, any, any>, opts: FindOptions, template: string,
  matches: FindMatch[], currentIndex: number,
): boolean {
  const { regex } = buildRegex(opts)
  if (!regex) return false
  const target = matches[currentIndex]
  if (!target) return false
  let n = 0
  for (let k = 0; k < currentIndex; k++) if (matches[k].blockId === target.blockId) n++
  const clone = jsonClone(editor.getBlock(target.blockId))
  if (!clone) return false
  const { changed } = transformBlock(clone, regex, template, opts.mode, (idx) => idx === n)
  if (changed) editor.updateBlock(target.blockId, { content: (clone as any).content })
  return changed
}
