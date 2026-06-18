export function processCiteTags(text: string): string {
  // Split on fenced code blocks and inline code spans; odd-indexed parts are code — skip them
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g)
  return parts
    .map((part, i) => i % 2 === 0
      ? part.replace(/<cite[^>]*>([\s\S]*?)<\/cite>/g, '*$1*')
      : part)
    .join('')
}
