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

export function processCiteTags(text: string): string {
  // Split on fenced code blocks and inline code spans; odd-indexed parts are code — skip them
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g)
  return parts
    .map((part, i) => i % 2 === 0
      ? part.replace(/<cite[^>]*>([\s\S]*?)<\/cite>/g, '*$1*')
      : part)
    .join('')
}
