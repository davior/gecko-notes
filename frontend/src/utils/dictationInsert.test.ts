import { Schema, type Node as PMNode } from 'prosemirror-model'
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state'
import { describe, expect, it } from 'vitest'

import { insertDictationAtSelection, padDictatedText } from '@/utils/dictationInsert'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    image: { group: 'block', atom: true },
    text: { group: 'inline' },
    hard_break: { group: 'inline', inline: true, leafText: () => '\n' },
    mention: { group: 'inline', inline: true, atom: true },
  },
  marks: { strong: {} },
})

const p = (...content: (string | PMNode)[]) =>
  schema.node('paragraph', null, content.map((c) => (typeof c === 'string' ? schema.text(c) : c)))
const bold = (text: string) => schema.text(text, [schema.mark('strong')])

// Builds a one-paragraph-per-arg doc and puts a text cursor at `|` (or a
// range between two `|`s) in the first paragraph that has one.
function stateWithCursor(...paragraphs: string[]) {
  let anchor = -1
  let head = -1
  let pos = 0
  const nodes = paragraphs.map((src) => {
    const parts = src.split('|')
    let text = ''
    parts.forEach((part, i) => {
      if (i > 0) {
        const at = pos + 1 + text.length
        if (anchor < 0) anchor = at
        else head = at
      }
      text += part
    })
    const node = text ? p(text) : p()
    pos += node.nodeSize
    return node
  })
  const doc = schema.node('doc', null, nodes)
  return EditorState.create({ doc, selection: TextSelection.create(doc, anchor, head < 0 ? anchor : head) })
}

// Dictates each chunk in turn, the way consecutive speech results arrive.
function dictate(state: EditorState, ...chunks: string[]) {
  for (const chunk of chunks) {
    const tr = state.tr
    expect(insertDictationAtSelection(tr, chunk)).toBe(true)
    state = state.apply(tr)
  }
  return state
}

// Paragraph texts with the caret marked as `|`.
function show(state: EditorState) {
  const { from } = state.selection
  const out: string[] = []
  state.doc.forEach((node, offset) => {
    const start = offset + 1
    const text = node.textBetween(0, node.content.size, undefined, (n) => n.type.spec.leafText?.(n) ?? '@')
    out.push(from >= start && from <= start + node.content.size
      ? text.slice(0, from - start) + '|' + text.slice(from - start)
      : text)
  })
  return out
}

describe('insertDictationAtSelection', () => {
  it('types at the cursor in the middle of a note, not at the bottom', () => {
    const state = dictate(stateWithCursor('First line', 'Hello |world', 'Last line'), 'there')
    expect(show(state)).toEqual(['First line', 'Hello there |world', 'Last line'])
  })

  it('continues each new chunk from where the last one ended, in order', () => {
    const state = dictate(stateWithCursor('Hello |world'), 'one', 'two', 'three')
    expect(show(state)).toEqual(['Hello one two three |world'])
  })

  it('adds a leading space after a word and none into an empty line', () => {
    expect(show(dictate(stateWithCursor('Hello|'), 'there'))).toEqual(['Hello there|'])
    expect(show(dictate(stateWithCursor('|'), 'Hello'))).toEqual(['Hello|'])
  })

  it('does not space away from surrounding punctuation or brackets', () => {
    expect(show(dictate(stateWithCursor('Hello|.'), 'there'))).toEqual(['Hello there|.'])
    expect(show(dictate(stateWithCursor('(|)'), 'aside'))).toEqual(['(aside|)'])
  })

  it('collapses a range selection to its end instead of overwriting it', () => {
    const state = dictate(stateWithCursor('keep |this| text'), 'and more')
    expect(show(state)).toEqual(['keep this and more| text'])
    expect(state.selection.empty).toBe(true)
  })

  it('normalizes whitespace and newlines in the recognized text', () => {
    expect(show(dictate(stateWithCursor('|'), '  one\n two  '))).toEqual(['one two|'])
  })

  it('picks up the marks at the cursor, like typing does', () => {
    const doc = schema.node('doc', null, [p(bold('bold'))])
    const state = dictate(EditorState.create({ doc, selection: TextSelection.create(doc, 3) }), 'x')
    const para = state.doc.firstChild!
    expect(para.textContent).toBe('bo x ld')
    expect(para.childCount).toBe(1)
    expect(para.firstChild!.marks.map((m) => m.type.name)).toEqual(['strong'])
  })

  it('spaces away from an inline chip but not from a line break', () => {
    const afterBreak = schema.node('doc', null, [p('a', schema.node('hard_break'))])
    const s1 = dictate(EditorState.create({ doc: afterBreak, selection: TextSelection.atEnd(afterBreak) }), 'b')
    expect(show(s1)).toEqual(['a\nb|'])

    const afterChip = schema.node('doc', null, [p('see ', schema.node('mention'))])
    const s2 = dictate(EditorState.create({ doc: afterChip, selection: TextSelection.atEnd(afterChip) }), 'this')
    expect(show(s2)).toEqual(['see @ this|'])
  })

  it('refuses (leaving the transaction untouched) when the selection cannot hold text', () => {
    const doc = schema.node('doc', null, [p('text'), schema.node('image')])
    const state = EditorState.create({ doc, selection: NodeSelection.create(doc, 6) })
    const tr = state.tr
    expect(insertDictationAtSelection(tr, 'hello')).toBe(false)
    expect(tr.docChanged).toBe(false)
    expect(tr.selectionSet).toBe(false)
  })

  it('ignores empty or whitespace-only results', () => {
    const tr = stateWithCursor('Hello|').tr
    expect(insertDictationAtSelection(tr, '   ')).toBe(false)
    expect(tr.docChanged).toBe(false)
  })
})

describe('padDictatedText', () => {
  it('pads only where the neighbours are word characters', () => {
    expect(padDictatedText('b', 'a', 'c')).toBe(' b ')
    expect(padDictatedText('b', '', '')).toBe('b')
    expect(padDictatedText('b', ' ', ' ')).toBe('b')
  })

  it('does not put a space before text that starts with punctuation', () => {
    expect(padDictatedText(', and then', 'a', '')).toBe(', and then')
  })
})
