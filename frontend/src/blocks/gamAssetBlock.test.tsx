import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GamAsset } from '@/api/gam'
import type { GamEntry } from '@/stores/gam'

const getAsset = vi.fn()
vi.mock('@/api/gam', async (orig) => ({
  ...(await orig<typeof import('@/api/gam')>()),
  gamApi: { getAsset: (id: string) => getAsset(id), status: vi.fn(), search: vi.fn(), copyIntoNote: vi.fn() },
}))

const { GamAssetView, copiedBlockFor, playableUrl } = await import('./gamAssetBlock')
const { useGamStore, GAM_URL_TTL_MS } = await import('@/stores/gam')
const { describeGamAssets, exportBlockFor, resolveGamForExport } = await import('@/utils/gamExport')

function asset(fields: Partial<GamAsset> = {}): GamAsset {
  return {
    id: 'a1', name: 'Harbour', asset_type: 'image', description: null, original_name: 'harbour.png',
    mime_type: 'image/png', file_format: 'png', size_bytes: 2048, duration_seconds: null, width: 1, height: 1,
    in_point: null, out_point: null, file_url: 'https://assets.test/media/a1.png?sig=1',
    thumb_url: null, page_url: 'https://assets.test/a/a1', credit: '', missing: false, ...fields,
  }
}

type Entries = Record<string, GamEntry>
let entries: Entries = {}
let shared = false

function panel(props: Partial<{ assetId: string; name: string; assetType: string }> = {}) {
  const assetId = props.assetId ?? 'a1'
  return (
    <GamAssetView assetId={assetId} name="Harbour" assetType="image" onCopy={() => {}} {...props}
      shared={shared} enabled publicUrl="https://assets.test" entry={entries[assetId]} onRetry={() => {}} />
  )
}

beforeEach(() => {
  entries = {}
  shared = false
  useGamStore.getState().reset()
  getAsset.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('the gamAsset block', () => {
  it('shows an image GAM has given a fresh address for', () => {
    entries = { a1: { state: 'ready', asset: asset(), fetchedAt: Date.now() } }
    const html = renderToStaticMarkup(panel())
    expect(html).toContain('src="https://assets.test/media/a1.png?sig=1"')
    expect(html).toContain('Open in GAM')
    expect(html).toContain('Copy into note')
  })

  it('plays a video and shows a document as a card', () => {
    entries = {
      v1: { state: 'ready', asset: asset({ id: 'v1', asset_type: 'video', file_url: 'https://assets.test/v.mp4' }), fetchedAt: Date.now() },
      d1: { state: 'ready', asset: asset({ id: 'd1', name: 'Report', asset_type: 'document', file_format: 'pdf' }), fetchedAt: Date.now() },
    }
    expect(renderToStaticMarkup(panel({ assetId: 'v1' }))).toContain('<video')
    const doc = renderToStaticMarkup(panel({ assetId: 'd1' }))
    expect(doc).toContain('Report')
    expect(doc).toContain('PDF · 2 KB')
    expect(doc).toContain('Download')
  })

  it('says when the asset is gone from the library', () => {
    entries = { a1: { state: 'missing' } }
    expect(renderToStaticMarkup(panel())).toContain('no longer in your GAM library')
  })

  it('offers a retry when GAM could not be reached', () => {
    entries = { a1: { state: 'error', message: 'Could not reach the asset library' } }
    const html = renderToStaticMarkup(panel())
    expect(html).toContain('Could not reach the asset library')
    expect(html).toContain('Retry')
  })

  it('in a shared note names the asset and never shows its file', () => {
    entries = { a1: { state: 'ready', asset: asset(), fetchedAt: Date.now() } }
    shared = true
    const html = renderToStaticMarkup(panel())
    expect(html).toContain('Harbour')
    expect(html).not.toContain('<img')
  })

  it('plays only a clip’s window of its parent', () => {
    expect(playableUrl(asset({ file_url: 'https://g/v.mp4', in_point: 5, out_point: 9.5 }))).toBe('https://g/v.mp4#t=5,9.5')
    expect(playableUrl(asset({ file_url: 'https://g/v.mp4' }))).toBe('https://g/v.mp4')
  })

  it('becomes the ordinary block for its type when copied', () => {
    expect(copiedBlockFor('image', '/media/u/x.png', 'n').type).toBe('image')
    expect(copiedBlockFor('video', '/media/u/x.mp4', 'n').type).toBe('videoFile')
    expect(copiedBlockFor('audio', '/media/u/x.mp3', 'n').type).toBe('audioFile')
    expect(copiedBlockFor('document', '/media/u/x.pdf', 'n')).toEqual({ type: 'file', props: { url: '/media/u/x.pdf', name: 'n' } })
  })
})

describe('the GAM store', () => {
  it('serves a fresh address from cache and asks again once it is near expiry', async () => {
    vi.useFakeTimers()
    getAsset.mockResolvedValue({ data: asset() })
    await useGamStore.getState().resolve('a1')
    await useGamStore.getState().resolve('a1')
    expect(getAsset).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(GAM_URL_TTL_MS + 1)
    await useGamStore.getState().resolve('a1')
    expect(getAsset).toHaveBeenCalledTimes(2)
  })

  it('records a 404 as missing, and anything else as an error with GAM’s sentence', async () => {
    getAsset.mockRejectedValueOnce({ response: { status: 404 } })
    expect((await useGamStore.getState().resolve('gone')).state).toBe('missing')
    getAsset.mockRejectedValueOnce({ response: { status: 502, data: { detail: { message: 'GAM is down' } } } })
    expect(await useGamStore.getState().resolve('a1')).toEqual({ state: 'error', message: 'GAM is down' })
  })

  it('drops an answer that lands after logout', async () => {
    let finish: (v: unknown) => void = () => {}
    getAsset.mockReturnValue(new Promise((r) => { finish = r }))
    const pending = useGamStore.getState().resolve('a1')
    useGamStore.getState().reset()
    finish({ data: asset() })
    await pending
    expect(useGamStore.getState().entries).toEqual({})
  })
})

describe('exports', () => {
  it('turn an image into an ordinary image and anything else into a link to GAM', () => {
    const block = { id: 'b', type: 'gamAsset', props: { assetId: 'a1', name: 'Harbour', assetType: 'image' } }
    expect(exportBlockFor(block, asset())).toMatchObject({ type: 'image', props: { url: 'https://assets.test/media/a1.png?sig=1' } })
    const link = exportBlockFor(block, asset({ asset_type: 'video' }))
    expect(link).toMatchObject({ type: 'paragraph', content: [{ type: 'link', href: 'https://assets.test/a/a1' }] })
    expect(JSON.stringify(exportBlockFor(block, null))).toContain('[GAM asset: Harbour]')
  })

  it('leave a note with no GAM blocks untouched, without asking GAM', async () => {
    const content = JSON.stringify([{ id: 'p', type: 'paragraph', content: [], children: [] }])
    expect(await resolveGamForExport(content)).toBe(content)
    expect(getAsset).not.toHaveBeenCalled()
  })

  it('resolve nested GAM blocks', async () => {
    getAsset.mockResolvedValue({ data: asset() })
    const content = JSON.stringify([{ id: 'l', type: 'bulletListItem', children: [
      { id: 'g', type: 'gamAsset', props: { assetId: 'a1', name: 'Harbour', assetType: 'image' }, children: [] }] }])
    const [item] = JSON.parse(await resolveGamForExport(content))
    expect(item.children[0].type).toBe('image')
  })

  it('describe a note’s GAM assets for the assistant', () => {
    expect(describeGamAssets([{ type: 'gamAsset', props: { assetId: 'a1', name: 'Harbour', assetType: 'image' } }]))
      .toBe('- [GAM image “Harbour” — asset id a1]')
  })
})
