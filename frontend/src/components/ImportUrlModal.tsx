import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { X, Globe, Loader2, Image as ImageIcon } from 'lucide-react'
import { importUrlApi, importErrorMessage, type UrlExtractResult } from '@/api/importUrl'

const DOWNLOAD_PREF_KEY = 'importUrlDownloadResources'

interface Props {
  /** Creates the note. Resolves when it's saved; rejects to show an error here. */
  onImport: (result: UrlExtractResult, downloadResources: boolean) => Promise<void>
  onClose: () => void
}

export default function ImportUrlModal({ onImport, onClose }: Props) {
  const [url, setUrl] = useState('')
  const [downloadResources, setDownloadResources] = useState<boolean>(() => {
    try { return localStorage.getItem(DOWNLOAD_PREF_KEY) !== 'false' } catch { return true }
  })
  const [fetching, setFetching] = useState(false)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<UrlExtractResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  function setDownloadPref(next: boolean) {
    setDownloadResources(next)
    try { localStorage.setItem(DOWNLOAD_PREF_KEY, String(next)) } catch { /* private mode */ }
  }

  async function fetchPage() {
    const trimmed = url.trim()
    if (!trimmed || fetching) return
    // Typing "example.com/article" is the common case; assume https rather than failing.
    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    setFetching(true)
    setError(null)
    setResult(null)
    try {
      setResult(await importUrlApi.extract(normalized))
    } catch (e) {
      setError(importErrorMessage(e, 'Could not read that page'))
    } finally {
      setFetching(false)
    }
  }

  async function runImport() {
    if (!result || importing) return
    setImporting(true)
    setError(null)
    try {
      await onImport(result, downloadResources)
      onClose()
    } catch (e) {
      setError(importErrorMessage(e, 'Could not create the note'))
      setImporting(false)
    }
  }

  const busy = fetching || importing
  const meta = result
    ? [result.site_name, result.byline, result.published].filter(Boolean).join(' · ')
    : ''

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-2xl mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 dark:border-gray-700">
          <Globe className="w-4 h-4 text-blue-500 shrink-0" />
          <h3 className="flex-1 text-sm font-semibold text-gray-900 dark:text-gray-100">Import URL</h3>
          <button className="btn-ghost p-1" onClick={onClose} aria-label="Close"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <div>
            <label className="label" htmlFor="import-url-input">Page address</label>
            <div className="flex gap-2">
              <input
                id="import-url-input"
                className="input flex-1"
                type="url"
                inputMode="url"
                placeholder="https://example.com/an-article"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void fetchPage() }}
                disabled={importing}
                autoFocus
              />
              <button
                className="btn-secondary text-sm flex items-center gap-1.5 shrink-0"
                disabled={busy || !url.trim()}
                onClick={() => void fetchPage()}
              >
                {fetching ? <><Loader2 className="w-4 h-4 animate-spin" /> Reading…</> : result ? 'Reload' : 'Fetch'}
              </button>
            </div>
          </div>

          <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 rounded border-gray-300 dark:border-gray-600"
              checked={downloadResources}
              onChange={(e) => setDownloadPref(e.target.checked)}
              disabled={importing}
            />
            <span>
              Download images into my library
              <span className="block text-xs text-gray-500 dark:text-gray-400">
                Keeps the note readable if the original page changes or goes away. Leave off to
                link to the images where they are.
              </span>
            </span>
          </label>

          {error && <p className="text-sm text-red-500">{error}</p>}

          {result && (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
              <div className="px-3 py-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">{result.title}</p>
                {meta && <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{meta}</p>}
                {result.image_urls.length > 0 && (
                  <p className="mt-1 flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                    <ImageIcon className="w-3 h-3" />
                    {result.image_urls.length} image{result.image_urls.length !== 1 ? 's' : ''}
                    {downloadResources ? ' will be downloaded' : ' will stay linked'}
                  </p>
                )}
              </div>
              <div className="px-3 py-2 max-h-64 overflow-y-auto prose-sm text-sm text-gray-700 dark:text-gray-300 leading-relaxed [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h1]:mt-2 [&_h2]:mt-2 [&_p]:my-1.5 [&_img]:max-w-full [&_img]:rounded [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:text-blue-600 [&_a]:underline [&_table]:text-xs [&_blockquote]:border-l-2 [&_blockquote]:border-gray-300 [&_blockquote]:pl-2 [&_blockquote]:italic">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{result.markdown}</ReactMarkdown>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 justify-end">
            <button className="btn-secondary text-sm" onClick={onClose} disabled={importing}>Cancel</button>
            <button
              className="btn-primary text-sm flex items-center gap-1.5"
              disabled={!result || busy}
              onClick={() => void runImport()}
            >
              {importing ? <><Loader2 className="w-4 h-4 animate-spin" /> Importing…</> : 'Import'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
