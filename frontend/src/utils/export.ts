import type { Note } from '@/api/notes'
import type Turndown from 'turndown'
import { notesApi } from '@/api/notes'
import { renderMermaid, svgToDataUri, noteIdFromHref } from '@/utils/diagram'

// Rasterise a diagram SVG to a PNG (Uint8Array) for embedding in a Word document,
// which can't display SVG. Sized from the SVG's own width/height attributes (falling
// back to the viewBox's width/height if Mermaid omits explicit attributes), drawn at 2×
// for crisp output on a white background.
async function svgToPngData(svg: string): Promise<{ data: Uint8Array; width: number; height: number }> {
  const m = svg.match(/^<svg[^>]*\swidth="([\d.]+)"[^>]*\sheight="([\d.]+)"/)
  let width = m ? Math.round(parseFloat(m[1])) : 0
  let height = m ? Math.round(parseFloat(m[2])) : 0
  if (!width || !height) {
    const vb = svg.match(/\sviewBox="[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)"/)
    width = vb ? Math.round(parseFloat(vb[1])) : 640
    height = vb ? Math.round(parseFloat(vb[2])) : 360
  }
  const bytes = new TextEncoder().encode(svg)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  const dataUri = `data:image/svg+xml;base64,${btoa(bin)}`
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('svg load failed'))
    img.src = dataUri
  })
  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = width * scale
  canvas.height = height * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
  if (!blob) throw new Error('toBlob failed')
  return { data: new Uint8Array(await blob.arrayBuffer()), width, height }
}

type DocxParagraph = InstanceType<(typeof import('docx'))['Paragraph']>
type DocxTextRun = InstanceType<(typeof import('docx'))['TextRun']>
type DocxTable = InstanceType<(typeof import('docx'))['Table']>

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
      if (block.type === 'audioFile') {
        texts.push('[Audio recording]')
        return
      }
      if (block.type === 'diagram') {
        const diagramProps = block.props as Record<string, unknown> | undefined
        const diagramSource = ((diagramProps?.source as string) ?? '').trim()
        texts.push(diagramSource ? `\n\`\`\`mermaid\n${diagramSource}\n\`\`\`\n` : '[Diagram]')
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

// ─── Helper: extract inline content from a table cell (handles both formats) ──

function extractCellInlineContent(cell: unknown): unknown[] {
  if (Array.isArray(cell)) return cell
  if (typeof cell === 'object' && cell !== null) {
    const c = cell as Record<string, unknown>
    if (c.type === 'tableCell' && Array.isArray(c.content)) return c.content as unknown[]
  }
  return []
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

async function buildBlocksHTML(blocks: Record<string, unknown>[], mode: 'render' | 'source' = 'render'): Promise<string> {
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
        const nested = Array.isArray(bch) && bch.length > 0 ? await buildBlocksHTML(bch, mode) : ''
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
        const nested = Array.isArray(bch) && bch.length > 0 ? await buildBlocksHTML(bch, mode) : ''
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
        const nested = Array.isArray(bch) && bch.length > 0 ? await buildBlocksHTML(bch, mode) : ''
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

    if (type === 'audioFile') {
      const url = props?.url as string | undefined
      if (url) {
        const name = escapeHtml((props?.name as string) ?? '')
        parts.push(`<figure style="margin:16px 0"><audio controls src="${escapeHtml(url)}"${name ? ` data-name="${name}"` : ''}></audio></figure>`)
      }
      i++
      continue
    }

    if (type === 'videoFile') {
      const url = props?.url as string | undefined
      if (url) {
        const name = escapeHtml((props?.name as string) ?? '')
        parts.push(`<figure style="margin:16px 0"><video controls src="${escapeHtml(url)}"${name ? ` data-name="${name}"` : ''} style="max-width:100%;height:auto;"></video></figure>`)
      }
      i++
      continue
    }

    if (type === 'diagram') {
      if (mode === 'source') {
        const source = (props?.source as string) ?? ''
        parts.push(`<pre><code class="language-mermaid">${escapeHtml(source)}</code></pre>`)
        i++
        continue
      }
      const { svg, error } = await renderMermaid((props?.source as string) ?? '')
      if (svg) {
        parts.push(`<figure style="margin:16px 0"><img src="${svgToDataUri(svg)}" style="max-width:100%;height:auto;" alt="Diagram" /></figure>`)
      } else if (error) {
        parts.push(`<p style="color:#b91c1c;font-style:italic">[Diagram: ${escapeHtml(error)}]</p>`)
      }
      i++
      continue
    }

    if (type === 'heading') {
      const level = (props?.level as number) ?? 1
      const tag = `h${Math.min(Math.max(level, 1), 6)}`
      const nested = Array.isArray(children) && children.length > 0 ? await buildBlocksHTML(children, mode) : ''
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

    if (type === 'table') {
      const tableData = block.content as { rows?: Array<{ cells: unknown[][] }> } | undefined
      const rows = tableData?.rows
      if (Array.isArray(rows) && rows.length > 0) {
        const headerCells = rows[0].cells.map((cell) => `<th>${buildInlineContent(extractCellInlineContent(cell))}</th>`).join('')
        const bodyRowsHTML = rows.slice(1).map((row) => {
          const cells = row.cells.map((cell) => `<td>${buildInlineContent(extractCellInlineContent(cell))}</td>`).join('')
          return `<tr>${cells}</tr>`
        }).join('')
        const tbody = bodyRowsHTML ? `<tbody>${bodyRowsHTML}</tbody>` : ''
        parts.push(`<table><thead><tr>${headerCells}</tr></thead>${tbody}</table>`)
      }
      i++
      continue
    }

    // paragraph and any unknown block types
    const nested = Array.isArray(children) && children.length > 0 ? await buildBlocksHTML(children, mode) : ''
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

async function noteToHTML(note: Note): Promise<string> {
  let bodyContent = ''
  try {
    const blocks = JSON.parse(note.content) as Record<string, unknown>[]
    bodyContent = await buildBlocksHTML(blocks)
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
  ul, ol { margin: 0.5em 0; padding-left: 1.5em; line-height: 1.6; }
  ul.checklist { list-style: none; padding-left: 0; margin-left: 0; }
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
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #d1d5db; padding: 8px 12px; text-align: left; vertical-align: top; }
  th { background-color: #f3f4f6; font-weight: bold; }
  tr:nth-child(even) td { background-color: #f9fafb; }
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

// ─── Resource bundling (ZIP exports) ──────────────────────────────────────────
//
// The "with resources" exporters package a note as a ZIP: the document at the root
// plus a shared `assets/` folder holding every embedded resource (images, audio,
// video, diagrams). In-app absolute references are rewritten to portable relative
// paths — resource `src`s become `assets/…`, and internal note links (`/notes/<id>`)
// become the linked note's own export filename. File naming is a single source of
// truth (`noteFileName`) so a future multi-note export can drop several documents
// into one ZIP with non-colliding assets and working cross-note links.

// URL/filesystem-safe slug from a note title: lowercase, word chars only, spaces and
// underscores collapsed to single hyphens, capped so long titles stay reasonable.
export function slugify(title: string): string {
  return (
    (title || '')
      .toLowerCase()
      .replace(/[^\w\s-]+/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'note'
  )
}

// The canonical base name a note maps to. The trailing id segment guarantees
// uniqueness (two notes may share a title) and makes a `/notes/<id>` link resolvable
// to exactly the file that note would be exported as.
export function noteBaseName(id: string, title: string): string {
  return `${slugify(title)}--${id.slice(0, 8)}`
}

export function noteFileName(id: string, title: string, ext: string): string {
  return `${noteBaseName(id, title)}.${ext}`
}

// Best-effort file extension for a fetched resource: prefer the data-URI / URL hint,
// then fall back to the blob's MIME type, then a generic default.
function extFromMime(mime: string): string | null {
  const map: Record<string, string> = {
    'image/svg+xml': 'svg', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
    'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/webm': 'weba',
    'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv', 'video/quicktime': 'mov',
  }
  const key = mime.split(';')[0].trim().toLowerCase()
  if (map[key]) return map[key]
  const sub = key.includes('/') ? key.split('/')[1].replace(/[^\w]/g, '') : ''
  return sub || null
}

function extFor(src: string, mime: string): string {
  if (src.startsWith('data:')) {
    const header = src.slice(5, src.indexOf(','))
    const ext = extFromMime(header)
    if (ext) return ext
  } else {
    const path = src.split('?')[0].split('#')[0]
    const dot = path.lastIndexOf('.')
    const slash = path.lastIndexOf('/')
    if (dot > slash && dot < path.length - 1) {
      const ext = path.slice(dot + 1).toLowerCase()
      if (/^[a-z0-9]{1,5}$/.test(ext)) return ext
    }
  }
  return (mime && extFromMime(mime)) || 'bin'
}

interface BundledAsset {
  name: string // filename within the ZIP's assets/ folder, e.g. "note--id__1.png"
  data: ArrayBuffer
}

// Walk a parsed note document: download every embedded resource into `assets/`,
// rewrite its `src` to the relative asset path, and rewrite internal note links to
// the linked note's export filename. Mutates `doc` in place; returns the assets.
async function collectResourcesAndRewrite(
  doc: Document,
  baseName: string,
  linkExt: 'md' | 'html',
): Promise<BundledAsset[]> {
  const assets: BundledAsset[] = []
  const bySrc = new Map<string, string>() // original src → relative "assets/<name>"
  let counter = 0

  const media = Array.from(doc.querySelectorAll('img, audio, video'))
  for (const el of media) {
    const src = el.getAttribute('src')
    if (!src) continue
    const cached = bySrc.get(src)
    if (cached) {
      el.setAttribute('src', cached)
      continue
    }
    try {
      const resp = await fetch(src)
      const blob = await resp.blob()
      const name = `${baseName}__${++counter}.${extFor(src, blob.type)}`
      assets.push({ name, data: await blob.arrayBuffer() })
      const rel = `assets/${name}`
      bySrc.set(src, rel)
      el.setAttribute('src', rel)
    } catch {
      // Unreachable resource (e.g. cross-origin without CORS): keep the original
      // absolute src so the export still succeeds, just not fully offline.
    }
  }

  // Internal note links → the linked note's export filename (same naming used for the
  // main file), so a future multi-note export produces working cross-note links.
  const filenameById = new Map<string, string | null>()
  const anchors = Array.from(doc.querySelectorAll('a[href]'))
  for (const a of anchors) {
    const href = a.getAttribute('href') ?? ''
    const id = noteIdFromHref(href)
    if (!id) continue
    if (!filenameById.has(id)) {
      try {
        const { data } = await notesApi.get(id)
        filenameById.set(id, noteFileName(data.id, data.title, linkExt))
      } catch {
        filenameById.set(id, null) // deleted / inaccessible — leave the link as-is
      }
    }
    const filename = filenameById.get(id)
    if (filename) a.setAttribute('href', filename)
  }

  return assets
}

// Bundle a document plus its assets into a ZIP and download it.
async function downloadZip(base: string, docName: string, docText: string, assets: BundledAsset[]): Promise<void> {
  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  zip.file(docName, docText)
  if (assets.length > 0) {
    const folder = zip.folder('assets')!
    for (const a of assets) folder.file(a.name, a.data)
  }
  const blob = await zip.generateAsync({ type: 'blob' })
  downloadBlob(blob, `${base}.zip`)
}

// ─── Export: PDF ──────────────────────────────────────────────────────────────

export async function exportToPDF(note: Note): Promise<void> {
  const { default: jsPDF } = await import('jspdf')
  const html2canvas = (await import('html2canvas')).default

  const container = document.createElement('div')
  container.style.cssText =
    'position:fixed;left:-9999px;top:0;width:658px;background:white;padding:0;font-family:Georgia,serif;color:#111;'

  const parser = new DOMParser()
  const parsedDoc = parser.parseFromString(await noteToHTML(note), 'text/html')
  const styleContent = parsedDoc.head.querySelector('style')?.textContent ?? ''
  // html2canvas can't render background-color on inline elements that wrap
  // across lines — it paints a full-width rectangle instead of following
  // the text flow. Override inline code to font-only styling for the PDF.
  // Also remove text shadows for clear, readable PDF output.
  const pdfStyleOverrides = `code { background: none !important; padding: 0 !important; border-radius: 0 !important; border: none !important; }
* { text-shadow: none !important; box-shadow: none !important; }`
  container.innerHTML = `<style>${styleContent}${pdfStyleOverrides}</style>${parsedDoc.body.innerHTML}`
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

  // html2canvas v1 doesn't render CSS ::marker pseudo-elements, so inject
  // bullet and number characters as plain text nodes before each <li>.
  container.querySelectorAll('ul:not(.checklist)').forEach((ul) => {
    ;(ul as HTMLElement).style.listStyle = 'none'
    ul.querySelectorAll(':scope > li').forEach((li) => {
      ;(li as HTMLElement).style.listStyle = 'none'
      li.insertBefore(document.createTextNode('• '), li.firstChild)
    })
  })
  container.querySelectorAll('ol').forEach((ol) => {
    ;(ol as HTMLElement).style.listStyle = 'none'
    let n = 1
    ol.querySelectorAll(':scope > li').forEach((li) => {
      ;(li as HTMLElement).style.listStyle = 'none'
      li.insertBefore(document.createTextNode(`${n++}. `), li.firstChild)
    })
  })

  try {
    const canvas = await html2canvas(container, { scale: 1.5 })
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
      pdf.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', margin.side, margin.top, contentWidth, sliceHeightMm)
    }

    pdf.save(`${note.title || 'note'}.pdf`)
  } finally {
    document.body.removeChild(container)
  }
}

// ─── Export: Word (.docx) ─────────────────────────────────────────────────────

export async function exportToWord(note: Note): Promise<void> {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun, ImageRun, UnderlineType, AlignmentType, Table, TableRow, TableCell, WidthType } =
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
        const linkContent = (item.content as Array<Record<string, unknown>>) ?? []
        for (const child of linkContent) {
          if (child.type === 'text') {
            const styles = child.styles as Record<string, unknown> | undefined
            runs.push(
              new TextRun({
                text: (child.text as string) ?? '',
                bold: !!(styles?.bold),
                italics: !!(styles?.italic),
                strike: !!(styles?.strikethrough),
                color: '2563EB',
                underline: { type: UnderlineType.SINGLE },
              })
            )
          }
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

  const paragraphs: (DocxParagraph | DocxTable)[] = [
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

  async function blockToParagraphs(block: Record<string, unknown>, depth: number): Promise<(DocxParagraph | DocxTable)[]> {
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

    if (type === 'audioFile') {
      // Audio can't be embedded in a Word document; leave a labeled placeholder.
      const label = (props?.name as string | undefined) || 'Audio recording'
      return [new Paragraph({ children: [new TextRun({ text: `[${label}]`, italics: true })] })]
    }

    if (type === 'diagram') {
      // Word can't render SVG, so rasterise the diagram to a PNG and embed it,
      // scaled to fit the page width.
      try {
        const { svg, error } = await renderMermaid((props?.source as string) ?? '')
        if (!svg) throw new Error(error ?? 'empty diagram')
        const { data, width, height } = await svgToPngData(svg)
        const maxW = 600
        const w = Math.min(width, maxW)
        const h = Math.round((height * w) / width)
        return [new Paragraph({ children: [new ImageRun({ data, type: 'png', transformation: { width: w, height: h } })] })]
      } catch {
        return [new Paragraph({ children: [new TextRun({ text: '[Diagram]', italics: true })] })]
      }
    }

    if (type === 'table') {
      const tableData = block.content as { rows?: Array<{ cells: unknown[][] }> } | undefined
      const rows = tableData?.rows
      if (Array.isArray(rows) && rows.length > 0) {
        const tableRows = rows.map((row) => {
          const tableCells = row.cells.map((cell) => {
            const cellRuns = buildWordRuns(extractCellInlineContent(cell) as Array<Record<string, unknown>>)
            return new TableCell({ children: [new Paragraph({ children: cellRuns })] })
          })
          return new TableRow({ children: tableCells })
        })
        return [new Table({ rows: tableRows, width: { size: 100, type: WidthType.PERCENTAGE } })]
      }
      return []
    }

    const runs = buildWordRuns(content)
    let childParas: (DocxParagraph | DocxTable)[] = []
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
      const lines = plainText.split('\n')
      const runs = lines.map((line, i) =>
        new TextRun({ text: line, font: 'Courier New', size: 18, break: i > 0 ? 1 : undefined })
      )
      return [new Paragraph({ children: runs })]
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

// GFM table support, shared by both Markdown exporters.
function addGfmTableRules(td: Turndown): void {
  td.addRule('tableCell', {
    filter: ['th', 'td'],
    replacement: (content: string) => ` ${content.trim().replace(/\n+/g, ' ')} |`,
  })
  td.addRule('tableRow', {
    filter: 'tr',
    replacement: (content: string, node: Node) => {
      const tr = node as HTMLElement
      const isHeader = tr.parentElement?.tagName === 'THEAD'
      const row = `|${content}\n`
      if (isHeader) {
        const colCount = tr.querySelectorAll('th, td').length
        const separator = `| ${Array(colCount).fill('---').join(' | ')} |\n`
        return row + separator
      }
      return row
    },
  })
  td.addRule('table', {
    filter: 'table',
    replacement: (content: string) => `\n\n${content}\n`,
  })
}

export async function exportToMarkdown(note: Note): Promise<void> {
  const TurndownService = (await import('turndown')).default
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  addGfmTableRules(td)

  let blocks: Record<string, unknown>[] = []
  try { blocks = JSON.parse(note.content) } catch { blocks = [] }

  const bodyHTML = `<h1>${escapeHtml(note.title)}</h1>${await buildBlocksHTML(blocks, 'source')}`
  const frontmatter = buildMarkdownFrontmatter(note)
  const md = `${frontmatter}\n\n${td.turndown(bodyHTML)}`
  downloadText(md, `${note.title || 'note'}.md`, 'text/markdown')
}

// ─── Export: Markdown + resources (ZIP) ───────────────────────────────────────

export async function exportToMarkdownWithResources(note: Note): Promise<void> {
  const TurndownService = (await import('turndown')).default
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  addGfmTableRules(td)
  // Turndown drops <audio>/<video> by default — represent them as links to the
  // bundled asset (their src has already been rewritten to assets/… below).
  td.addRule('mediaEmbed', {
    filter: ['audio', 'video'],
    replacement: (_content: string, node: Node) => {
      const el = node as HTMLElement
      const src = el.getAttribute('src') ?? ''
      if (!src) return ''
      const label = el.getAttribute('data-name') || (el.tagName.toLowerCase() === 'video' ? 'Video' : 'Audio')
      return `\n\n[${label}](${src})\n\n`
    },
  })

  let blocks: Record<string, unknown>[] = []
  try { blocks = JSON.parse(note.content) } catch { blocks = [] }

  const base = noteBaseName(note.id, note.title)
  const bodyHTML = `<h1>${escapeHtml(note.title)}</h1>${await buildBlocksHTML(blocks, 'source')}`
  const doc = new DOMParser().parseFromString(bodyHTML, 'text/html')
  const assets = await collectResourcesAndRewrite(doc, base, 'md')
  const frontmatter = buildMarkdownFrontmatter(note)
  const md = `${frontmatter}\n\n${td.turndown(doc.body.innerHTML)}`
  await downloadZip(base, `${base}.md`, md, assets)
}

// ─── Export: HTML ─────────────────────────────────────────────────────────────

export async function exportToHTML(note: Note): Promise<void> {
  const html = await noteToHTML(note)
  downloadText(html, `${note.title || 'note'}.html`, 'text/html')
}

// ─── Export: HTML + resources (ZIP) ───────────────────────────────────────────

export async function exportToHTMLWithResources(note: Note): Promise<void> {
  const base = noteBaseName(note.id, note.title)
  const html = await noteToHTML(note)
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const assets = await collectResourcesAndRewrite(doc, base, 'html')
  const finalHtml = `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`
  await downloadZip(base, `${base}.html`, finalHtml, assets)
}

// ─── Export: Clipboard (plain text) ──────────────────────────────────────────

export async function copyAsPlainText(note: Note): Promise<void> {
  const text = `${note.title}\n\n${extractPlainText(note.content)}`
  await navigator.clipboard.writeText(text)
}

// ─── Export: Clipboard (rich text) ───────────────────────────────────────────

export async function copyAsRichText(note: Note): Promise<void> {
  const html = await noteToHTML(note)
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
