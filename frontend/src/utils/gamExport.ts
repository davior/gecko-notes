import { gamApi, type GamAsset } from '@/api/gam'

// Exports (PDF, Word, Markdown, HTML, the bulk zip) know nothing of `gamAsset` blocks,
// and should not: a file outlives the hour GAM signs its addresses for. So before an
// exporter reads a note, each GAM block becomes something every exporter already
// handles. An image becomes an ordinary image with a fresh address, which the exporters
// that bundle or embed images then fetch; anything else (video, audio, a document)
// becomes a link to the asset's page in GAM, which is stable. A block that can't be
// resolved (GAM down, the asset gone) becomes its name, so the export still says what
// was there.

type Block = Record<string, unknown>

function text(value: string) {
  return { type: 'text', text: value, styles: {} }
}

export function exportBlockFor(block: Block, asset: GamAsset | null): Block {
  const props = (block.props ?? {}) as Record<string, string>
  const name = asset?.name || props.name || 'GAM asset'
  if (asset && asset.asset_type === 'image' && asset.file_url) {
    return { id: block.id, type: 'image', props: { url: asset.file_url, name, caption: name, showPreview: true }, children: [] }
  }
  if (asset) {
    return {
      id: block.id,
      type: 'paragraph',
      props: {},
      content: [{ type: 'link', href: asset.page_url, content: [text(`${name} (${asset.asset_type} in GAM)`)] }],
      children: [],
    }
  }
  return { id: block.id, type: 'paragraph', props: {}, content: [text(`[GAM asset: ${name}]`)], children: [] }
}

function collectIds(blocks: Block[], into: Set<string>) {
  for (const block of blocks) {
    if (block.type === 'gamAsset') {
      const id = (block.props as Record<string, string> | undefined)?.assetId
      if (id) into.add(id)
    }
    if (Array.isArray(block.children)) collectIds(block.children as Block[], into)
  }
}

function replace(blocks: Block[], assets: Map<string, GamAsset | null>): Block[] {
  return blocks.map((block) => {
    const children = Array.isArray(block.children) ? replace(block.children as Block[], assets) : block.children
    if (block.type !== 'gamAsset') return { ...block, children }
    const id = (block.props as Record<string, string> | undefined)?.assetId ?? ''
    return exportBlockFor(block, assets.get(id) ?? null)
  })
}

/** A note's stored content with its GAM blocks made exportable. Content that isn't
 * block JSON, or has no GAM blocks, comes back untouched without asking GAM anything. */
export async function resolveGamForExport(content: string): Promise<string> {
  let blocks: Block[]
  try {
    blocks = JSON.parse(content)
  } catch {
    return content
  }
  if (!Array.isArray(blocks)) return content
  const ids = new Set<string>()
  collectIds(blocks, ids)
  if (ids.size === 0) return content
  const assets = new Map<string, GamAsset | null>()
  await Promise.all(
    [...ids].map(async (id) => {
      try {
        assets.set(id, (await gamApi.getAsset(id)).data)
      } catch {
        assets.set(id, null)
      }
    }),
  )
  return JSON.stringify(replace(blocks, assets))
}

/** The GAM assets in a note, one line each, for the assistant's context. BlockNote's
 * Markdown leaves custom blocks out, so without this the model would not know they are
 * there (read_gam_asset takes the id). */
export function describeGamAssets(blocks: unknown[]): string {
  const out: string[] = []
  const walk = (list: unknown[]) => {
    for (const b of list) {
      const rec = b as Block | null
      if (!rec || typeof rec !== 'object') continue
      if (rec.type === 'gamAsset') {
        const props = (rec.props as Record<string, unknown>) || {}
        out.push(`- [GAM ${String(props.assetType || 'asset')} “${String(props.name || 'Untitled')}” — asset id ${String(props.assetId ?? '')}]`)
      }
      if (Array.isArray(rec.children)) walk(rec.children as unknown[])
    }
  }
  walk(blocks)
  return out.join('\n')
}
