import type { Node as PMNode } from 'prosemirror-model'
import { TextSelection, type Transaction } from 'prosemirror-state'

// Characters that a dictated phrase shouldn't be separated from by a space:
// nothing is needed after whitespace or an opening bracket/quote, and before
// whitespace or closing punctuation.
const NO_SPACE_AFTER = /[\s([{‘“]/
const NO_SPACE_BEFORE = /[\s.,;:!?)\]}’”]/

/** Speech results can carry stray leading/trailing spaces or line breaks; a
 *  dictated chunk is always inserted as a single run of words. */
export function normalizeDictatedText(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

/**
 * Pads dictated `text` with spaces so it doesn't fuse onto the characters
 * immediately `before` and `after` the insertion point (empty string when the
 * insertion point is at the start/end of its line).
 */
export function padDictatedText(text: string, before: string, after: string): string {
  let padded = text
  if (before && !NO_SPACE_AFTER.test(before) && !NO_SPACE_BEFORE.test(text[0])) padded = ` ${padded}`
  if (after && !NO_SPACE_BEFORE.test(after)) padded = `${padded} `
  return padded
}

// Inline nodes without text (a hard break, a mention chip) still count as
// something to space away from; ones that render as whitespace don't.
const leafText = (node: PMNode) => node.type.spec.leafText?.(node) ?? '￼'

/**
 * Types `text` into the document at the transaction's selection, the way the
 * keyboard would: a range selection is collapsed to its end first (dictating
 * never overwrites what's selected), the words pick up the marks at that
 * position, and the caret is left right after them so the next dictated
 * chunk continues from there.
 *
 * ProseMirror keeps its selection when the editor loses focus, so this works
 * even while focus sits on the mic button rather than in the note.
 *
 * Returns false without touching `tr` when the selection isn't in a text
 * block (e.g. an image block is selected, or the whole document), so the
 * caller can fall back to starting a new paragraph.
 */
export function insertDictationAtSelection(tr: Transaction, text: string): boolean {
  const words = normalizeDictatedText(text)
  const $pos = tr.selection.$to
  const parent = $pos.parent
  if (!words || !parent.inlineContent) return false

  const offset = $pos.parentOffset
  const before = parent.textBetween(Math.max(0, offset - 1), offset, undefined, leafText)
  const after = parent.textBetween(offset, Math.min(parent.content.size, offset + 1), undefined, leafText)
  const padded = padDictatedText(words, before, after)

  tr.insertText(padded, $pos.pos)
  tr.setSelection(TextSelection.create(tr.doc, $pos.pos + padded.length))
  tr.scrollIntoView()
  return true
}
