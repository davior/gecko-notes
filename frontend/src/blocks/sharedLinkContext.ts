import { createContext } from 'react'

export interface SharedLinkContextValue {
  // Maps a linked note's id to the share token of its shared page.
  shareTokens: Record<string, string>
  // The share token and title of the note currently being viewed, so a
  // noteReference block can pass "where you navigated from" along when
  // linking to the referenced note's shared page.
  currentToken: string
  currentTitle: string
}

// Non-null only when the note tree is being rendered inside the public shared
// view (SharedNoteView). childNote/noteReference blocks use this to link to
// other notes' shared pages instead of the private /notes/:id edit route.
export const SharedLinkContext = createContext<SharedLinkContextValue | null>(null)
