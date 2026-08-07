// Turns a list-view search query — natural language ("notes from the first week of
// January about the new year") or advanced syntax ("tags:Animals", "date:2026-02-02
// and category:Ideas") — into a structured NoteSearchFilter, executed server-side by
// POST /notes/search. The model never emits SQL, only this validated JSON shape.
// Mirrors the JSON-extraction approach in aiPlan.ts (fenced block, else the first
// brace-balanced object that parses), since the model may wrap its output in prose
// despite instructions.

import type { AIService } from './ai'
import type { NoteSearchFilter, AnnualRange } from '@/api/notes'

export interface SmartQueryCategory { id: string; label: string }

export const SMART_QUERY_INSTRUCTIONS = `You turn a note-search query into a structured JSON filter. The query may be natural language (e.g. "find notes from the first week of January about the new year") or advanced syntax (e.g. "tags:Animals", "date:2026-02-02 and category:Ideas"), or a mix. Output ONLY a single JSON object matching this shape (every field is optional — omit ones that don't apply):

{
  "text_all": ["<term>", ...],   // every term must appear in the title or body (AND)
  "text_any": ["<term>", ...],   // at least one term must appear (OR) — prefer this for topical/subject phrases
  "tags": ["<tag>", ...],        // from "tags:" syntax — matches ANY of these tags
  "category_ids": ["<id>", ...], // from "category:" syntax — resolve the label to an id from the list below
  "date_field": "created_at" | "modified_at",  // "created_at" for written/created, "modified_at" for edited/updated (default created_at)
  "date_from": "YYYY-MM-DD",     // inclusive start of an absolute date range
  "date_to": "YYYY-MM-DD",       // inclusive end of an absolute date range
  "annual_ranges": [{ "start_month": 1-12, "start_day": 1-31, "end_month": 1-12, "end_day": 1-31 }],  // a recurring month/day window matched in ANY year — use for phrasing like "any year", "every January", "the first week of January" ({"start_month":1,"start_day":1,"end_month":1,"end_day":7})
  "is_pinned": true | false
}

Rules:
- Extract meaningful keywords/phrases from natural language into "text_any" (or "text_all" when the request implies several distinct terms must ALL be present). Do not include stopword-only fragments.
- "tags:" and "category:" clauses may combine with each other or with plain text (e.g. joined by "and"); parse each clause into its matching field.
- "category:" values must be matched against the category list below by label (case-insensitive) and turned into that category's id. If nothing matches, omit category_ids.
- Prefer "annual_ranges" over "date_from"/"date_to" whenever the request says "any year" or otherwise implies a recurring calendar window; use "date_from"/"date_to" for a specific, single-year range.
- Output ONLY the JSON object. No prose, no markdown code fences, no explanation.`

export function buildSmartQueryPrompt(query: string, categories: SmartQueryCategory[], currentDate: string): string {
  const categoryList = categories.length
    ? categories.map((c) => `- ${c.id} — ${c.label}`).join('\n')
    : '(none)'
  return `Current date (UTC): ${currentDate}

Categories (id — label):
${categoryList}

Search query: ${query}`
}

// Index of the '}' matching the '{' at `open`. Braces inside JSON string literals
// (and their backslash escapes) are ignored, mirroring aiPlan.ts's matchBrace.
function matchBrace(text: string, open: number): number {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return i }
  }
  return -1
}

// Locates the JSON object in a (possibly prose-wrapped) model response: prefers a
// fenced ```json block, else scans for the first brace-balanced slice that parses.
function extractJsonObject(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) {
    const inner = fence[1].trim()
    if (inner.startsWith('{')) {
      try { return JSON.parse(inner) } catch { /* fall through to the brace scan */ }
    }
  }
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    const end = matchBrace(text, i)
    if (end === -1) continue
    try { return JSON.parse(text.slice(i, end + 1)) } catch { /* keep scanning */ }
  }
  throw new Error('No JSON object found in AI response')
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const arr = v.filter((x): x is string => typeof x === 'string').slice(0, 50)
  return arr.length ? arr : undefined
}

function asAnnualRanges(v: unknown): AnnualRange[] | undefined {
  if (!Array.isArray(v)) return undefined
  const ranges: AnnualRange[] = []
  for (const item of v.slice(0, 50)) {
    if (typeof item !== 'object' || item === null) continue
    const r = item as Record<string, unknown>
    const nums = [r.start_month, r.start_day, r.end_month, r.end_day]
    if (nums.some((n) => typeof n !== 'number')) continue
    const [start_month, start_day, end_month, end_day] = nums as number[]
    if (start_month < 1 || start_month > 12 || end_month < 1 || end_month > 12) continue
    if (start_day < 1 || start_day > 31 || end_day < 1 || end_day > 31) continue
    ranges.push({ start_month, start_day, end_month, end_day })
  }
  return ranges.length ? ranges : undefined
}

function asDateString(v: unknown): string | undefined {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined
}

// Validates/coerces the model's raw JSON into a NoteSearchFilter, dropping anything
// malformed rather than failing the whole search (e.g. an unparsable date just means
// no date filter is applied, not that the request errors out).
function toNoteSearchFilter(raw: unknown): NoteSearchFilter {
  if (typeof raw !== 'object' || raw === null) throw new Error('AI response is not a JSON object')
  const o = raw as Record<string, unknown>
  const filter: NoteSearchFilter = {}

  const textAll = asStringArray(o.text_all); if (textAll) filter.text_all = textAll
  const textAny = asStringArray(o.text_any); if (textAny) filter.text_any = textAny
  const tags = asStringArray(o.tags); if (tags) filter.tags = tags
  const categoryIds = asStringArray(o.category_ids); if (categoryIds) filter.category_ids = categoryIds
  if (o.date_field === 'modified_at') filter.date_field = 'modified_at'
  const dateFrom = asDateString(o.date_from); if (dateFrom) filter.date_from = dateFrom
  const dateTo = asDateString(o.date_to); if (dateTo) filter.date_to = dateTo
  const annualRanges = asAnnualRanges(o.annual_ranges); if (annualRanges) filter.annual_ranges = annualRanges
  if (typeof o.is_pinned === 'boolean') filter.is_pinned = o.is_pinned

  return filter
}

export interface GenerateNoteFilterOpts {
  query: string
  categories: SmartQueryCategory[]
}

// Turns a search query into a NoteSearchFilter via the active AI provider. Throws on
// any failure (network error, unparsable response, empty filter) so the caller can
// fall back to a plain keyword search.
export async function generateNoteFilter(
  aiService: AIService,
  { query, categories }: GenerateNoteFilterOpts,
): Promise<NoteSearchFilter> {
  const currentDate = new Date().toISOString().slice(0, 10)
  const prompt = buildSmartQueryPrompt(query, categories, currentDate)
  const result = await aiService.complete(prompt, { systemPrompt: SMART_QUERY_INSTRUCTIONS })
  const filter = toNoteSearchFilter(extractJsonObject(result))

  const hasCriteria = Boolean(
    filter.text_all?.length || filter.text_any?.length || filter.tags?.length ||
    filter.category_ids?.length || filter.date_from || filter.date_to ||
    filter.annual_ranges?.length || filter.is_pinned !== undefined,
  )
  if (!hasCriteria) throw new Error('AI produced an empty search filter')
  return filter
}
