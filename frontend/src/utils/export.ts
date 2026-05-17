import type { Note } from '@/api/notes'

type DocxParagraph = InstanceType<(typeof import('docx'))['Paragraph']>
type DocxTextRun = InstanceType<(typeof import('docx'))['TextRun']>

// ─── Helper: extract plain text (images become [Image] references) ────────────

function extractPlainText(contentStr: string): string {
  try {
    const blocks = JSON.parse(contentStr)
    const texts: string[] = []
    function processBlock(block: Record<string, unknown>) {
      if (block.type === 'image') {
        texts.push('[Image]')
        return
      }
      const content = block.content
      if (Array.isArray(content)) {
        for (const item of content) {
          if (typeof item === 'object' && item !== null) {
            const typedItem = item as Record<string, unknown>
            if (typedItem.type === 'text' && typeof typedItem.text === 'string') {
              texts.push(typedItem.text)
            }
          }
        }
      }
      const children = block.children
      if (Array.isArray(children)) {
        for (const child of children) {
          if (typeof child === 'object' && child !== null) {
            processBlock(child as Record<string, unknown>)
          }
        }
      }
    }
    for (const block of blocks) {
      processBlock(block)
      texts.push('\n')
    }
    return texts.join('').trim()
  } catch {
    return contentStr
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatDate(isoStr: string): string {
  try {
    return new Date(isoStr).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  } catch {
    return isoStr
  }
}

// ─── Helper: render inline content with full style support ───────────────────

function buildInlineContent(content: unknown[]): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue
    const typed = item as Record<string, unknown>
    if (typed.type === 'link') {
      const href = escapeHtml((typed.href as string) ?? '')
      const inner = buildInlineContent((typed.content as unknown[]) ?? [])
      parts.push(`<a href="${href}">${inner}</a>`)
    } else if (typed.type === 'text') {
      let text = escapeHtml((typed.text as string) ?? '')
      const styles = typed.styles as Record<string, unknown> | undefined
      if (styles?.code) text = `<code>${text}</code>`
      if (styles?.bold) text = `<strong>${text}</strong>`
      if (styles?.italic) text = `<em>${text}</em>`
      if (styles?.underline) text = `<u>${text}</u>`
      if (styles?.strikethrough) text = `<s>${text}</s>`
      parts.push(text)
    }
  }
  return parts.join('')
}

// ─── Helper: convert blocks array to HTML with correct element types ──────────

function buildBlocksHTML(blocks: Record<string, unknown>[]): string {
  if (!Array.isArray(blocks) || blocks.length === 0) return ''
  const parts: string[] = []
  let i = 0
  while (i < blocks.length) {
    const block = blocks[i]
    const type = block.type as string
    const content = block.content as unknown[] | undefined
    const children = block.children as Record<string, unknown>[] | undefined
    const props = block.props as Record<string, unknown> | undefined

    if (type === 'bulletListItem') {
      const items: string[] = []
      while (i < blocks.length && blocks[i].type === 'bulletListItem') {
        const b = blocks[i]
        const bc = b.content as unknown[] | undefined
        const bch = b.children as Record<string, unknown>[] | undefined
        const nested = Array.isArray(bch) && bch.length > 0 ? buildBlocksHTML(bch) : ''
        items.push(`<li>${buildInlineContent(bc ?? [])}${nested}</li>`)
        i++
      }
      parts.push(`<ul>${items.join('')}</ul>`)
      continue
    }

    if (type === 'numberedListItem') {
      const items: string[] = []
      while (i < blocks.length && blocks[i].type === 'numberedListItem') {
        const b = blocks[i]
        const bc = b.content as unknown[] | undefined
        const bch = b.children as Record<string, unknown>[] | undefined
        const nested = Array.isArray(bch) && bch.length > 0 ? buildBlocksHTML(bch) : ''
        items.push(`<li>${buildInlineContent(bc ?? [])}${nested}</li>`)
        i++
      }
      parts.push(`<ol>${items.join('')}</ol>`)
      continue
    }

    if (type === 'checkListItem') {
      const items: string[] = []
      while (i < blocks.length && blocks[i].type === 'checkListItem') {
        const b = blocks[i]
        const bc = b.content as unknown[] | undefined
        const bch = b.children as Record<string, unknown>[] | undefined
        const bp = b.props as Record<string, unknown> | undefined
        const checked = bp?.checked === true
        const nested = Array.isArray(bch) && bch.length > 0 ? buildBlocksHTML(bch) : ''
        items.push(`<li>${checked ? '&#9745;' : '&#9744;'} ${buildInlineContent(bc ?? [])}${nested}</li>`)
        i++
      }
      parts.push(`<ul class="checklist">${items.join('')}</ul>`)
      continue
    }

    if (type === 'image') {
      const url = props?.url as string | undefined
      if (url) {
        parts.push(`<figure style="margin:16px 0"><img src="${escapeHtml(url)}" style="max-width:100%;height:auto;" /></figure>`)
      }
      i++
      continue
    }

    if (type === 'heading') {
      const level = (props?.level as number) ?? 1
      const tag = `h${Math.min(Math.max(level, 1), 6)}`
      const nested = Array.isArray(children) && children.length > 0 ? buildBlocksHTML(children) : ''
      parts.push(`<${tag}>${buildInlineContent(content ?? [])}</${tag}>${nested}`)
      i++
      continue
    }

    if (type === 'codeBlock') {
      const lang = escapeHtml((props?.language as string) ?? '')
      const langAttr = lang ? ` class="language-${lang}"` : ''
      parts.push(`<pre><code${langAttr}>${buildInlineContent(content ?? [])}</code></pre>`)
      i++
      continue
    }

    // paragraph and any unknown block types
    const nested = Array.isArray(children) && children.length > 0 ? buildBlocksHTML(children) : ''
    parts.push(`<p>${buildInlineContent(content ?? [])}</p>${nested}`)
    i++
  }
  return parts.join('')
}

// ─── Helper: metadata section HTML ───────────────────────────────────────────

function buildMetadataHTML(note: Note): string {
  const lines: string[] = []
  lines.push(`<p class="meta-dates">Created: <span>${formatDate(note.created_at)}</span>&nbsp;&nbsp;·&nbsp;&nbsp;Modified: <span>${formatDate(note.modified_at)}</span></p>`)
  if (note.tags.length > 0) {
    lines.push(`<p class="meta-tags">Tags: ${note.tags.map(escapeHtml).join(', ')}</p>`)
  }
  if (note.summary?.trim()) {
    lines.push(`<p class="meta-summary"><em>Summary:</em> ${escapeHtml(note.summary)}</p>`)
  }
  return `<div class="metadata">${lines.join('\n')}</div>`
}

// ─── Helper: render note to full HTML document ────────────────────────────────

function noteToHTML(note: Note): string {
  let bodyContent = ''
  try {
    const blocks = JSON.parse(note.content) as Record<string, unknown>[]
    bodyContent = buildBlocksHTML(blocks)
  } catch {
    bodyContent = note.content.split('\n').map((l) => `<p>${escapeHtml(l)}</p>`).join('')
  }

  return `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(note.title)}</title>
<style>
  body { font-family: Georgia, serif; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #111; box-sizing: border-box; }
  h1 { font-size: 2em; margin-bottom: 0.25em; }
  h2 { font-size: 1.5em; margin: 1em 0 0.4em; }
  h3 { font-size: 1.2em; margin: 1em 0 0.4em; }
  p { line-height: 1.6; margin: 0.5em 0; }
  ul, ol { margin: 0.5em 0 0.5em 1.5em; padding: 0; line-height: 1.6; }
  ul.checklist { list-style: none; margin-left: 0; padding-left: 0; }
  li { margin: 0.25em 0; }
  pre { background: #f5f5f5; border-radius: 4px; padding: 12px 16px; overflow-x: auto; margin: 0.75em 0; }
  code { font-family: 'Courier New', Courier, monospace; font-size: 0.9em; background: #f5f5f5; padding: 0.1em 0.3em; border-radius: 3px; }
  pre code { background: none; padding: 0; }
  strong { font-weight: bold; }
  em { font-style: italic; }
  u { text-decoration: underline; }
  s { text-decoration: line-through; }
  a { color: #2563eb; text-decoration: underline; }
  figure { margin: 16px 0; }
  img { max-width: 100%; height: auto; }
  .metadata { border-top: 1px solid #e5e7eb; border-bottom: 1px solid #e5e7eb; padding: 8px 0; margin: 0.5em 0 1.5em; color: #6b7280; font-size: 0.85em; font-family: system-ui, sans-serif; }
  .metadata p { margin: 2px 0; line-height: 1.5; }
</style>
</head>
<body>
  <h1>${escapeHtml(note.title)}</h1>
  ${buildMetadataHTML(note)}
  <div class="content">${bodyContent}</div>
</body>
</html>`
}

// ─── Helper: fetch image as ArrayBuffer with display dimensions ───────────────

async function fetchImageData(url: string): Promise<{ data: ArrayBuffer; width: number; height: number }> {
  const response = await fetch(url)
  const blob = await response.blob()
  const arrayBuffer = await blob.arrayBuffer()
  const objectUrl = URL.createObjectURL(blob)
  const dims = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const maxWidth = 600
      let w = img.naturalWidth
      let h = img.naturalHeight
      if (w > maxWidth) {
        h = Math.round((h * maxWidth) / w)
        w = maxWidth
      }
      resolve({ width: w, height: h })
    }
    img.onerror = reject
    img.src = objectUrl
  })
  URL.revokeObjectURL(objectUrl)
  return { data: arrayBuffer, ...dims }
}

// ─── Export: PDF ──────────────────────────────────────────────────────────────

export async function exportToPDF(note: Note): Promise<void> {
  const { default: jsPDF } = await import('jspdf')
  const html2canvas = (await import('html2canvas')).default

  const container = document.createElement('div')
  container.style.cssText =
    'position:fixed;left:-9999px;top:0;width:658px;background:white;padding:0;font-family:Georgia,serif;color:#111;'

  const parser = new DOMParser()
  const parsedDoc = parser.parseFromString(noteToHTML(note), 'text/html')
  const styleContent = parsedDoc.head.querySelector('style')?.textContent ?? ''
  container.innerHTML = `<style>${styleContent}</style>${parsedDoc.body.innerHTML}`
  document.body.appendChild(container)

  // Replace img src with data URLs so html2canvas can render cross-origin images
  await Promise.all(
    Array.from(container.querySelectorAll('img')).map(async (imgEl) => {
      const img = imgEl as HTMLImageElement
      try {
        const resp = await fetch(img.src)
        const blob = await resp.blob()
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as string)
          reader.onerror = reject
          reader.readAsDataURL(blob)
        })
        img.src = dataUrl
        await new Promise<void>((resolve) => {
          if (img.complete) resolve()
          else { img.onload = () => resolve(); img.onerror = () => resolve() }
        })
      } catch {
        // keep original src if fetch fails
      }
    })
  )

  try {
    const canvas = await html2canvas(container, { scale: 2 })
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    const pageWidth = pdf.internal.pageSize.getWidth()
    const pageHeight = pdf.internal.pageSize.getHeight()
    const margin = { top: 15, side: 18 } // mm
    const contentWidth = pageWidth - 2 * margin.side
    const contentHeight = pageHeight - 2 * margin.top

    // Canvas pixels per mm of content width
    const pxPerMm = canvas.width / contentWidth
    const contentHeightPx = Math.round(contentHeight * pxPerMm)

    // Scan pixel rows to find whitespace gaps for page breaks
    const ctx2d = canvas.getContext('2d')!
    const { data: pixels } = ctx2d.getImageData(0, 0, canvas.width, canvas.height)

    function isRowWhite(y: number): boolean {
      if (y < 0 || y >= canvas.height) return true
      const base = y * canvas.width * 4
      for (let x = 0; x < canvas.width; x++) {
        const i = base + x * 4
        if (pixels[i + 3] < 10) continue // transparent counts as white
        if (pixels[i] < 245 || pixels[i + 1] < 245 || pixels[i + 2] < 245) return false
      }
      return true
    }

    function findBreak(targetY: number): number {
      // Prefer scanning upward so the page never overflows
      for (let dy = 0; dy <= 80; dy++) {
        if (isRowWhite(targetY - dy)) return targetY - dy
      }
      return targetY
    }

    // Determine slice start positions, snapping each break to a whitespace row
    const starts: number[] = [0]
    let next = contentHeightPx
    while (next < canvas.height) {
      const breakY = findBreak(next)
      starts.push(breakY)
      next = breakY + contentHeightPx
    }

    // Render each slice as its own cropped image
    for (let p = 0; p < starts.length; p++) {
      if (p > 0) pdf.addPage()
      const sliceStart = starts[p]
      const sliceEnd = p + 1 < starts.length ? starts[p + 1] : canvas.height
      const sliceHeightPx = sliceEnd - sliceStart

      const slice = document.createElement('canvas')
      slice.width = canvas.width
      slice.height = sliceHeightPx
      slice.getContext('2d')!.drawImage(canvas, 0, sliceStart, canvas.width, sliceHeightPx, 0, 0, canvas.width, sliceHeightPx)

      const sliceHeightMm = (sliceHeightPx / canvas.width) * contentWidth
      pdf.addImage(slice.toDataURL('image/png'), 'PNG', margin.side, margin.top, contentWidth, sliceHeightMm)
    }

    pdf.save(`${note.title || 'note'}.pdf`)
  } finally {
    document.body.removeChild(container)
  }
}

// ─── Export: Word (.docx) ─────────────────────────────────────────────────────

export async function exportToWord(note: Note): Promise<void> {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun, ImageRun, UnderlineType, AlignmentType } =
    await import('docx')

  const orderedListLevels = [0, 1, 2].map((level) => ({
    level,
    format: 'decimal' as const,
    text: `%${level + 1}.`,
    alignment: AlignmentType.LEFT,
    style: {
      paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } },
    },
  }))

  function buildWordRuns(
    content: Array<Record<string, unknown>>
  ): DocxTextRun[] {
    if (!Array.isArray(content)) return []
    const runs: DocxTextRun[] = []
    for (const item of content) {
      if (item.type === 'link') {
        const inner = buildWordRuns((item.content as Array<Record<string, unknown>>) ?? [])
        for (const r of inner) {
          // Annotate link text with blue color and underline
          runs.push(
            new TextRun({
              ...(r as Record<string, unknown>),
              color: '2563EB',
              underline: { type: UnderlineType.SINGLE },
            })
          )
        }
      } else if (item.type === 'text') {
        const styles = item.styles as Record<string, unknown> | undefined
        runs.push(
          new TextRun({
            text: (item.text as string) ?? '',
            bold: !!(styles?.bold),
            italics: !!(styles?.italic),
            underline: styles?.underline ? { type: UnderlineType.SINGLE } : undefined,
            strike: !!(styles?.strikethrough),
            font: styles?.code ? 'Courier New' : undefined,
            size: styles?.code ? 18 : undefined,
          })
        )
      }
    }
    return runs
  }

  const paragraphs: DocxParagraph[] = [
    new Paragraph({ text: note.title, heading: HeadingLevel.TITLE }),
    new Paragraph({
      children: [
        new TextRun({
          text: `Created: ${formatDate(note.created_at)}    ·    Modified: ${formatDate(note.modified_at)}`,
          color: '6B7280',
          size: 18,
        }),
      ],
    }),
  ]
  if (note.tags.length > 0) {
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: `Tags: ${note.tags.join(', ')}`, color: '6B7280', size: 18 })],
      })
    )
  }
  if (note.summary?.trim()) {
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: `Summary: ${note.summary}`, italics: true, color: '6B7280', size: 18 })],
      })
    )
  }
  paragraphs.push(new Paragraph({ children: [] }))

  let blocks: Record<string, unknown>[] = []
  try {
    blocks = JSON.parse(note.content)
  } catch {
    blocks = []
  }

  async function blockToParagraphs(block: Record<string, unknown>, depth: number): Promise<DocxParagraph[]> {
    const type = block.type as string
    const content = (block.content as Array<Record<string, unknown>>) ?? []
    const children = (block.children as Record<string, unknown>[]) ?? []
    const props = block.props as Record<string, unknown> | undefined

    if (type === 'image') {
      const url = props?.url as string | undefined
      if (url) {
        try {
          const { data, width, height } = await fetchImageData(url)
          return [new Paragraph({ children: [new ImageRun({ data, type: 'png', transformation: { width, height } })] })]
        } catch {
          return [new Paragraph({ children: [new TextRun({ text: '[Image]', italics: true })] })]
        }
      }
      return [new Paragraph({ children: [] })]
    }

    const runs = buildWordRuns(content)
    let childParas: DocxParagraph[] = []
    for (const child of children) {
      childParas = childParas.concat(await blockToParagraphs(child as Record<string, unknown>, depth + 1))
    }

    if (type === 'heading') {
      const level = (props?.level as number) ?? 1
      const heading =
        level === 1 ? HeadingLevel.HEADING_1 :
        level === 2 ? HeadingLevel.HEADING_2 :
        HeadingLevel.HEADING_3
      return [new Paragraph({ children: runs, heading }), ...childParas]
    }

    if (type === 'bulletListItem') {
      return [new Paragraph({ children: runs, bullet: { level: depth } }), ...childParas]
    }

    if (type === 'numberedListItem') {
      return [
        new Paragraph({ children: runs, numbering: { reference: 'gecko-ordered-list', level: depth } }),
        ...childParas,
      ]
    }

    if (type === 'checkListItem') {
      const checked = props?.checked === true
      return [
        new Paragraph({
          children: [new TextRun({ text: checked ? '☑ ' : '☐ ' }), ...runs],
        }),
        ...childParas,
      ]
    }

    if (type === 'codeBlock') {
      const plainText = content.filter((i) => i.type === 'text').map((i) => (i.text as string) ?? '').join('')
      return [new Paragraph({ children: [new TextRun({ text: plainText, font: 'Courier New', size: 18 })] })]
    }

    return [new Paragraph({ children: runs }), ...childParas]
  }

  for (const block of blocks) {
    const paras = await blockToParagraphs(block, 0)
    paragraphs.push(...paras)
  }

  const doc = new Document({
    numbering: { config: [{ reference: 'gecko-ordered-list', levels: orderedListLevels }] },
    sections: [{
      properties: {
        page: {
          margin: { top: 850, right: 1021, bottom: 850, left: 1021 }, // 15mm top/bottom, 18mm left/right
        },
      },
      children: paragraphs,
    }],
  })

  const blob = await Packer.toBlob(doc)
  downloadBlob(blob, `${note.title || 'note'}.docx`)
}

// ─── Export: Markdown ─────────────────────────────────────────────────────────

function buildMarkdownFrontmatter(note: Note): string {
  const escape = (s: string) => s.replace(/"/g, '\\"')
  const lines = [
    '---',
    `title: "${escape(note.title)}"`,
    `created: "${formatDate(note.created_at)}"`,
    `modified: "${formatDate(note.modified_at)}"`,
  ]
  if (note.tags.length > 0) {
    lines.push(`tags: [${note.tags.map((t) => `"${escape(t)}"`).join(', ')}]`)
  }
  if (note.summary?.trim()) {
    lines.push(`summary: "${escape(note.summary)}"`)
  }
  lines.push('---')
  return lines.join('\n')
}

export async function exportToMarkdown(note: Note): Promise<void> {
  const TurndownService = (await import('turndown')).default
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })

  let blocks: Record<string, unknown>[] = []
  try { blocks = JSON.parse(note.content) } catch { blocks = [] }

  const bodyHTML = `<h1>${escapeHtml(note.title)}</h1>${buildBlocksHTML(blocks)}`
  const frontmatter = buildMarkdownFrontmatter(note)
  const md = `${frontmatter}\n\n${td.turndown(bodyHTML)}`
  downloadText(md, `${note.title || 'note'}.md`, 'text/markdown')
}

// ─── Export: HTML ─────────────────────────────────────────────────────────────

export function exportToHTML(note: Note): void {
  const html = noteToHTML(note)
  downloadText(html, `${note.title || 'note'}.html`, 'text/html')
}

// ─── Export: Clipboard (plain text) ──────────────────────────────────────────

export async function copyAsPlainText(note: Note): Promise<void> {
  const text = `${note.title}\n\n${extractPlainText(note.content)}`
  await navigator.clipboard.writeText(text)
}

// ─── Export: Clipboard (rich text) ───────────────────────────────────────────

export async function copyAsRichText(note: Note): Promise<void> {
  const html = noteToHTML(note)
  const plain = `${note.title}\n\n${extractPlainText(note.content)}`
  const htmlBlob = new Blob([html], { type: 'text/html' })
  const plainBlob = new Blob([plain], { type: 'text/plain' })
  await navigator.clipboard.write([
    new ClipboardItem({
      'text/html': htmlBlob,
      'text/plain': plainBlob,
    }),
  ])
}

// ─── Download helpers ─────────────────────────────────────────────────────────

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function downloadText(text: string, filename: string, mimeType: string): void {
  downloadBlob(new Blob([text], { type: mimeType }), filename)
}
