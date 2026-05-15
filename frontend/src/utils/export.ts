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

// ─── Helper: render note to HTML string (with images) ────────────────────────

function noteToHTML(note: Note): string {
  let bodyContent = ''
  try {
    const blocks = JSON.parse(note.content) as Record<string, unknown>[]
    const parts: string[] = []

    function processBlock(block: Record<string, unknown>) {
      if (block.type === 'image') {
        const props = block.props as Record<string, unknown> | undefined
        const url = props?.url as string | undefined
        if (url) {
          parts.push(`<figure style="margin:16px 0"><img src="${escapeHtml(url)}" style="max-width:100%;height:auto;" /></figure>`)
        }
        return
      }
      const content = block.content
      const texts: string[] = []
      if (Array.isArray(content)) {
        for (const item of content) {
          if (typeof item === 'object' && item !== null) {
            const typedItem = item as Record<string, unknown>
            if (typedItem.type === 'text' && typeof typedItem.text === 'string') {
              texts.push(escapeHtml(typedItem.text))
            }
          }
        }
      }
      parts.push(`<p>${texts.join('')}</p>`)
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
    }
    bodyContent = parts.join('')
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
  body { font-family: Georgia, serif; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #111; }
  h1 { font-size: 2em; margin-bottom: 0.5em; }
  p { line-height: 1.6; margin: 0.5em 0; }
  figure { margin: 16px 0; }
  img { max-width: 100%; height: auto; }
</style>
</head>
<body>
  <h1>${escapeHtml(note.title)}</h1>
  <div class="content">${bodyContent}</div>
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
    'position:fixed;left:-9999px;top:0;width:794px;background:white;padding:40px;font-family:Georgia,serif;color:#111;'

  let contentHTML = `<h1 style="font-size:28px;margin-bottom:16px">${escapeHtml(note.title)}</h1><div style="line-height:1.6">`
  try {
    const blocks = JSON.parse(note.content) as Record<string, unknown>[]
    function buildBlockHTML(block: Record<string, unknown>): string {
      if (block.type === 'image') {
        const props = block.props as Record<string, unknown> | undefined
        const url = props?.url as string | undefined
        if (url) {
          return `<figure style="margin:8px 0"><img src="${escapeHtml(url)}" style="max-width:100%;height:auto;" /></figure>`
        }
        return ''
      }
      const content = block.content as Array<{ type: string; text: string }> | undefined
      const text = Array.isArray(content)
        ? content.filter((i) => i.type === 'text').map((i) => escapeHtml(i.text)).join('')
        : ''
      const children = block.children as Record<string, unknown>[] | undefined
      const childrenHTML = Array.isArray(children) ? children.map(buildBlockHTML).join('') : ''
      return `<p>${text}</p>${childrenHTML}`
    }
    contentHTML += blocks.map(buildBlockHTML).join('')
  } catch {
    contentHTML += extractPlainText(note.content).split('\n').map((l) => `<p>${escapeHtml(l)}</p>`).join('')
  }
  contentHTML += '</div>'
  container.innerHTML = contentHTML
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
  const { Document, Packer, Paragraph, HeadingLevel, TextRun, ImageRun } = await import('docx')

  const paragraphs: DocxParagraph[] = [
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

  async function blockToParagraph(block: Record<string, unknown>): Promise<DocxParagraph> {
    if (block.type === 'image') {
      const props = block.props as Record<string, unknown> | undefined
      const url = props?.url as string | undefined
      if (url) {
        try {
          const { data, width, height } = await fetchImageData(url)
          return new Paragraph({
            children: [new ImageRun({ data, transformation: { width, height } })],
          })
        } catch {
          return new Paragraph({ children: [new TextRun({ text: '[Image]', italics: true })] })
        }
      }
      return new Paragraph({ children: [] })
    }

    const blockType = block.type as string
    const content = block.content as Array<{ type: string; text: string; styles?: Record<string, boolean> }> | undefined
    const runs: DocxTextRun[] = []

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
      const heading =
        level === 2 ? HeadingLevel.HEADING_2 :
        level === 3 ? HeadingLevel.HEADING_3 :
        HeadingLevel.HEADING_1
      return new Paragraph({ children: runs, heading })
    }

    return new Paragraph({ children: runs })
  }

  for (const block of blocks) {
    paragraphs.push(await blockToParagraph(block))
    const children = block.children as Record<string, unknown>[] | undefined
    if (Array.isArray(children)) {
      for (const child of children) {
        paragraphs.push(await blockToParagraph(child))
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
