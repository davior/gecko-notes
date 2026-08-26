// Matches a spoken Deepgram Flux utterance like "run the summary recipe" against the
// user's saved recipes, so voice mode can trigger one hands-free.

export interface RecipeVoiceMatch {
  id: string
  name: string
}

const COMMAND_RE = /^(?:please\s+)?(?:run|use|start|trigger|do|launch)\s+(?:the\s+)?(.+?)(?:\s+recipe)?$/

export function matchRecipeVoiceCommand<T extends RecipeVoiceMatch>(transcript: string, recipes: T[]): T | null {
  if (recipes.length === 0) return null
  const norm = transcript.trim().toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!norm) return null
  const m = norm.match(COMMAND_RE)
  if (!m) return null
  const spoken = m[1].trim()
  if (!spoken) return null

  const exact = recipes.find((r) => r.name.trim().toLowerCase() === spoken)
  if (exact) return exact

  // Fall back to a loose containment match (spoken name is a substring of, or
  // contains, the recipe's name), preferring the longest/most specific match.
  const candidates = recipes
    .filter((r) => {
      const name = r.name.trim().toLowerCase()
      return name.length > 0 && (spoken.includes(name) || name.includes(spoken))
    })
    .sort((a, b) => b.name.length - a.name.length)
  return candidates[0] ?? null
}
