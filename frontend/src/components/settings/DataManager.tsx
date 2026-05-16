import { useRef, useState } from 'react'
import { Download, Upload, CheckCircle, XCircle, Loader2, FileArchive } from 'lucide-react'
import dataApi, { ImportUploadResult } from '@/api/data'

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

interface UploadedPart {
  filename: string
  result: ImportUploadResult
}

export default function DataManager() {
  // ── Export state ──────────────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false)
  const [exportStatus, setExportStatus] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  // ── Import state ──────────────────────────────────────────────────────────
  const [uploading, setUploading] = useState(false)
  const [uploadedParts, setUploadedParts] = useState<UploadedPart[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [applyResult, setApplyResult] = useState<{ notes: number; categories: number; media: number } | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const hasDataJson = uploadedParts.some((p) => p.result.has_data_json)
  const totalMedia = uploadedParts.reduce((acc, p) => acc + p.result.media_count, 0)

  // ── Export ─────────────────────────────────────────────────────────────────
  async function handleExport() {
    setExporting(true)
    setExportStatus(null)
    setExportError(null)
    try {
      const manifest = await dataApi.getExportManifest()
      const { total_parts } = manifest
      for (let i = 0; i < total_parts; i++) {
        setExportStatus(
          total_parts === 1
            ? 'Generating archive…'
            : `Downloading part ${i + 1} of ${total_parts}…`,
        )
        const { blob, filename } = await dataApi.downloadExportPart(i)
        triggerDownload(blob, filename)
        // Small delay so the browser doesn't block multiple downloads
        if (i < total_parts - 1) await new Promise((r) => setTimeout(r, 400))
      }
      setExportStatus(
        total_parts === 1
          ? 'Export complete.'
          : `Export complete — ${total_parts} parts downloaded.`,
      )
    } catch {
      setExportError('Export failed. Please try again.')
    } finally {
      setExporting(false)
    }
  }

  // ── Import – file upload ───────────────────────────────────────────────────
  async function handleFilesSelected(files: FileList | null) {
    if (!files || files.length === 0) return
    setUploading(true)
    setImportError(null)

    let currentSessionId = sessionId
    const newParts: UploadedPart[] = []

    try {
      for (const file of Array.from(files)) {
        const result = await dataApi.uploadImportPart(file, currentSessionId ?? undefined)
        currentSessionId = result.session_id
        newParts.push({ filename: file.name, result })
      }
      setSessionId(currentSessionId)
      setUploadedParts((prev) => [...prev, ...newParts])
    } catch {
      setImportError('Upload failed. Check the file and try again.')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // ── Import – apply ─────────────────────────────────────────────────────────
  async function handleApply() {
    if (!sessionId) return
    setApplying(true)
    setImportError(null)
    try {
      const result = await dataApi.applyImport(sessionId)
      setApplyResult({ notes: result.imported_notes, categories: result.imported_categories, media: result.imported_media })
      setUploadedParts([])
      setSessionId(null)
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: { message?: string } } } })?.response?.data?.detail
          ?.message ?? 'Import failed. Please try again.'
      setImportError(msg)
    } finally {
      setApplying(false)
    }
  }

  function handleReset() {
    setUploadedParts([])
    setSessionId(null)
    setApplyResult(null)
    setImportError(null)
  }

  return (
    <div className="space-y-10">
      {/* ── Export ─────────────────────────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">Export</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Download all your notes and media as a ZIP archive. If the data exceeds 48 MB the archive
          is split into multiple parts that can each be re-imported.
        </p>

        <div className="card p-5 space-y-4">
          <button
            className="btn-primary flex items-center gap-2"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            {exporting ? 'Exporting…' : 'Export Data'}
          </button>

          {exportStatus && !exportError && (
            <p className="text-sm text-gray-600 dark:text-gray-400 flex items-center gap-1.5">
              {exporting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <CheckCircle className="w-3.5 h-3.5 text-green-500" />
              )}
              {exportStatus}
            </p>
          )}

          {exportError && (
            <p className="text-sm text-red-600 dark:text-red-400 flex items-center gap-1.5">
              <XCircle className="w-3.5 h-3.5" />
              {exportError}
            </p>
          )}
        </div>
      </section>

      {/* ── Import ─────────────────────────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">Import</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Upload one or more export ZIP parts. Upload all media parts before clicking{' '}
          <strong>Apply Import</strong>.
        </p>

        <div className="card p-5 space-y-5">
          {/* Completed import result */}
          {applyResult && (
            <div className="rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 p-4 space-y-1">
              <p className="text-sm font-medium text-green-800 dark:text-green-300 flex items-center gap-1.5">
                <CheckCircle className="w-4 h-4" /> Import complete
              </p>
              <ul className="text-sm text-green-700 dark:text-green-400 list-disc list-inside space-y-0.5 pl-1">
                <li>{applyResult.notes} note{applyResult.notes !== 1 ? 's' : ''} imported</li>
                <li>{applyResult.categories} categor{applyResult.categories !== 1 ? 'ies' : 'y'} imported</li>
                <li>{applyResult.media} media file{applyResult.media !== 1 ? 's' : ''} imported</li>
              </ul>
              <button
                className="text-xs text-green-600 dark:text-green-400 underline mt-1"
                onClick={handleReset}
              >
                Start another import
              </button>
            </div>
          )}

          {/* File picker */}
          {!applyResult && (
            <>
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".zip"
                  multiple
                  className="hidden"
                  onChange={(e) => handleFilesSelected(e.target.files)}
                />
                <button
                  className="btn-secondary flex items-center gap-2"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || applying}
                >
                  {uploading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Upload className="w-4 h-4" />
                  )}
                  {uploading ? 'Uploading…' : 'Select ZIP file(s)'}
                </button>
              </div>

              {/* Uploaded parts list */}
              {uploadedParts.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                    Uploaded parts
                  </p>
                  <ul className="space-y-1.5">
                    {uploadedParts.map((part, idx) => (
                      <li
                        key={idx}
                        className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"
                      >
                        <FileArchive className="w-4 h-4 text-gray-400 shrink-0" />
                        <span className="truncate flex-1">{part.filename}</span>
                        <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />
                      </li>
                    ))}
                  </ul>

                  {/* Status summary */}
                  <div className="flex gap-4 pt-1 text-sm">
                    <span className={`flex items-center gap-1 ${hasDataJson ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}`}>
                      {hasDataJson ? <CheckCircle className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                      data.json {hasDataJson ? 'found' : 'not yet uploaded'}
                    </span>
                    <span className="text-gray-500 dark:text-gray-400">
                      {totalMedia} media file{totalMedia !== 1 ? 's' : ''} staged
                    </span>
                  </div>
                </div>
              )}

              {/* Apply button */}
              {uploadedParts.length > 0 && (
                <button
                  className="btn-primary flex items-center gap-2"
                  onClick={handleApply}
                  disabled={!hasDataJson || applying}
                >
                  {applying ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Download className="w-4 h-4" />
                  )}
                  {applying ? 'Importing…' : 'Apply Import'}
                </button>
              )}
            </>
          )}

          {importError && (
            <p className="text-sm text-red-600 dark:text-red-400 flex items-center gap-1.5">
              <XCircle className="w-3.5 h-3.5" />
              {importError}
            </p>
          )}
        </div>
      </section>
    </div>
  )
}
