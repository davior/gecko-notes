import { createContext } from 'react'

export interface EditorNoteContextValue {
  id: string
  title: string
}

// Identifies the note currently open in the editor. A noteReference block
// rendered inside it reads this to pass "where you navigated from" along when
// the user clicks through to the referenced note (see noteReferenceBlock.tsx),
// so the referenced note can offer a link back.
export const EditorNoteContext = createContext<EditorNoteContextValue | null>(null)
