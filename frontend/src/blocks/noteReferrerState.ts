// Shape of the react-router navigation `state` a noteReference block passes
// when linking to the referenced note, so that note can offer a link back to
// where the user came from. Only ever set by an in-app navigation (never by a
// direct URL visit/refresh), which is exactly the "came from a reference"
// condition callers want to detect.
export interface EditorReferrerState {
  fromNoteId: string
  fromTitle: string
}

export interface SharedReferrerState {
  fromToken: string
  fromTitle: string
}
