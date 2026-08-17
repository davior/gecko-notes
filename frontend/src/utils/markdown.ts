// Parses the "title" / "tags" keys out of a leading YAML frontmatter block
// (the same shape produced by exportToMarkdown), so re-importing an exported
// .md file restores its title and tags instead of dumping the frontmatter
// into the note body. Files with no frontmatter are returned unchanged.
export function parseMarkdownFrontmatter(md: string): { title?: string; tags?: string[]; body: string } {
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { body: md }

  const unquote = (s: string) => s.trim().replace(/^"([\s\S]*)"$/, '$1').replace(/\\"/g, '"')
  let title: string | undefined
  let tags: string[] | undefined

  for (const line of match[1].split(/\r?\n/)) {
    const titleMatch = line.match(/^title:\s*(.*)$/)
    if (titleMatch) {
      title = unquote(titleMatch[1])
      continue
    }
    const tagsMatch = line.match(/^tags:\s*\[(.*)\]$/)
    if (tagsMatch) {
      tags = tagsMatch[1]
        .split(',')
        .map((t) => unquote(t))
        .filter(Boolean)
    }
  }

  return { title, tags, body: md.slice(match[0].length) }
}

/** Escape the characters that would turn a link label into markup. */
function escapeMarkdownText(s: string): string {
  return s.replace(/([\\`*_[\]()])/g, '\\$1')
}

/** "https://example.com/some/article?x=1" -> "example.com/some/article" */
function linkLabelFor(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    const host = parsed.hostname.replace(/^www\./, '')
    const path = parsed.pathname.replace(/\/$/, '')
    const label = `${host}${path}`
    return label.length > 70 ? `${label.slice(0, 69)}…` : label
  } catch {
    return rawUrl
  }
}

/**
 * Assemble the note body for an imported web page: a source line, an optional byline,
 * then the extracted content.
 *
 * Extractors emit the article's own <h1> as a leading `# Heading`, which would sit in
 * the note directly under the identical note title — so when the two match, the
 * duplicate is dropped.
 */
export function buildImportedMarkdown(page: {
  url: string
  title: string
  markdown: string
  byline?: string | null
  published?: string | null
}): string {
  let body = page.markdown.trimStart()

  // Anchored to the very start (no /m): a `## Subheading` further down is not the
  // article's own title and must not be consumed.
  const leadingHeading = body.match(/^#[ \t]+(.+?)[ \t]*(?:\n|$)/)
  if (leadingHeading) {
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalize(leadingHeading[1]) === normalize(page.title)) {
      body = body.slice(leadingHeading[0].length).trimStart()
    }
  }

  const lines = [`Source: [${escapeMarkdownText(linkLabelFor(page.url))}](${page.url})`]
  const credit = [page.byline && `By ${page.byline}`, page.published]
    .filter(Boolean)
    .join(' · ')
  if (credit) lines.push(escapeMarkdownText(credit))

  return `${lines.join('\n\n')}\n\n${body}`
}

export function processCiteTags(text: string): string {
  // Split on fenced code blocks and inline code spans; odd-indexed parts are code — skip them
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g)
  return parts
    .map((part, i) => i % 2 === 0
      ? part.replace(/<cite[^>]*>([\s\S]*?)<\/cite>/g, '*$1*')
      : part)
    .join('')
}
