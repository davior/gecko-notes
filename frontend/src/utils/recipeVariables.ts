// Placeholder substitution for Recipes (saved prompt templates). Supports
// `{{title}}`, `{{selected text}}`, `{{date}}` (and a couple of natural aliases) so a
// recipe like "Summarize this note" can fill in the current note's title without the
// user retyping it.

export interface RecipeVariableContext {
  title?: string
  selectedText?: string
  date?: Date
}

// Placeholder keys are matched loosely — case/space/underscore-insensitive — so
// {{Selected Text}}, {{selected_text}}, and {{selectedText}} all resolve the same way.
function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s_-]+/g, '')
}

export function getRecipeVariables(ctx: RecipeVariableContext): Record<string, string> {
  const date = ctx.date ?? new Date()
  const title = ctx.title?.trim() || 'Untitled'
  const selectedText = ctx.selectedText?.trim() || ''
  return {
    title,
    notetitle: title,
    selectedtext: selectedText,
    selection: selectedText,
    date: date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }),
    time: date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
  }
}

// Replace every {{placeholder}} token in a recipe prompt template. A token with no
// matching variable is left untouched (rather than blanked out) so the user notices
// it didn't resolve instead of silently losing text.
export function renderRecipePrompt(template: string, ctx: RecipeVariableContext): string {
  const vars = getRecipeVariables(ctx)
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, rawKey: string) => {
    const key = normalizeKey(rawKey)
    return key in vars ? vars[key] : match
  })
}

// The current browser text selection, if any — used to fill {{selected text}}.
export function getCurrentSelectionText(): string {
  try {
    return window.getSelection()?.toString() ?? ''
  } catch {
    return ''
  }
}

// Shown in the recipe editor so authors know which placeholders are available.
export const RECIPE_VARIABLE_HELP: { token: string; description: string }[] = [
  { token: '{{title}}', description: "The current note's title" },
  { token: '{{selected text}}', description: 'Text currently selected/highlighted' },
  { token: '{{date}}', description: "Today's date" },
]
