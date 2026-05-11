import type { Note } from '@/api/notes'

// ─── Helper: extract plain text from BlockNote JSON ───────────────────────────

function extractPlainText(contentStr: string): string {
  try {
    const blocks = JSON.parse(contentStr)
    const texts: string[] = []
    function processBlock(block: Record<string, unknown>) {
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

// ─── Helper: render note to HTML string ──────────────────────────────────────

function noteToHTML(note: Note): string {
  const plainText = extractPlainText(note.content)
  const lines = plainText.split('\n').map((line) => `<p>${escapeHtml(line)}</p>`).join('')
  return `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(note.title)}</title>
<style>
  body { font-family: Georgia, serif; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #111; }
  h1 { font-size: 2em; margin-bottom: 0.5em; }
  p { line-height: 1.6; margin: 0.5em 0; }
</style>
</head>
<body>
  <h1>${escapeHtml(note.title)}</h1>
  <div class="content">${lines}</div>
</body>
</html>`
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ─── Export: PDF ──────────────────────────────────────────────────────────────

export async function exportToPDF(note: Note): Promise<void> {
  const { default: jsPDF } = await import('jspdf')
  const html2canvas = (await import('html2canvas')).default

  const container = document.createElement('div')
  container.style.cssText =
    'position:fixed;left:-9999px;top:0;width:794px;background:white;padding:40px;font-family:Georgia,serif;color:#111;'
  container.innerHTML = `<h1 style="font-size:28px;margin-bottom:16px">${escapeHtml(note.title)}</h1><div style="line-height:1.6">${extractPlainText(note.content).split('\n').map((l) => `<p>${escapeHtml(l)}</p>`).join('')}</div>`
  document.body.appendChild(container)

  try {
    const canvas = await html2canvas(container, { scale: 2 })
    const imgData = canvas.toDataURL('image/png')
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    const pageWidth = pdf.internal.pageSize.getWidth()
    const pageHeight = pdf.internal.pageSize.getHeight()
    const imgWidth = pageWidth
    const imgHeight = (canvas.height * pageWidth) / canvas.width

    let yOffset = 0
    let heightLeft = imgHeight

    pdf.addImage(imgData, 'PNG', 0, 0, imgWidth, imgHeight)
    heightLeft -= pageHeight

    while (heightLeft > 0) {
      yOffset -= pageHeight
      pdf.addPage()
      pdf.addImage(imgData, 'PNG', 0, yOffset, imgWidth, imgHeight)
      heightLeft -= pageHeight
    }

    pdf.save(`${note.title || 'note'}.pdf`)
  } finally {
    document.body.removeChild(container)
  }
}

// ─── Export: Word (.docx) ─────────────────────────────────────────────────────

export async function exportToWord(note: Note): Promise<void> {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import('docx')

  const paragraphs: Paragraph[] = [
    new Paragraph({
      text: note.title,
      heading: HeadingLevel.TITLE,
    }),
  ]

  let blocks: Record<string, unknown>[] = []
  try {
    blocks = JSON.parse(note.content)
  } catch {
    blocks = []
  }

  function blockToParagraph(block: Record<string, unknown>): Paragraph {
    const blockType = block.type as string
    const content = block.content as Array<{ type: string; text: string; styles?: Record<string, boolean> }> | undefined
    const runs: TextRun[] = []

    if (Array.isArray(content)) {
      for (const item of content) {
        if (item.type === 'text') {
          runs.push(
            new TextRun({
              text: item.text,
              bold: item.styles?.bold ?? false,
              italics: item.styles?.italic ?? false,
            })
          )
        }
      }
    }

    if (blockType === 'heading') {
      const level = (block.props as Record<string, unknown>)?.level as number
      const headingMap: Record<number, HeadingLevel> = {
        1: HeadingLevel.HEADING_1,
        2: HeadingLevel.HEADING_2,
        3: HeadingLevel.HEADING_3,
      }
      return new Paragraph({ children: runs, heading: headingMap[level] ?? HeadingLevel.HEADING_1 })
    }

    return new Paragraph({ children: runs })
  }

  for (const block of blocks) {
    paragraphs.push(blockToParagraph(block))
    const children = block.children as Record<string, unknown>[] | undefined
    if (Array.isArray(children)) {
      for (const child of children) {
        paragraphs.push(blockToParagraph(child))
      }
    }
  }

  const doc = new Document({
    sections: [{ children: paragraphs }],
  })

  const blob = await Packer.toBlob(doc)
  downloadBlob(blob, `${note.title || 'note'}.docx`)
}

// ─── Export: Markdown ─────────────────────────────────────────────────────────

export async function exportToMarkdown(note: Note): Promise<void> {
  const TurndownService = (await import('turndown')).default
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  const html = noteToHTML(note)
  const md = `# ${note.title}\n\n${td.turndown(html)}`
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
