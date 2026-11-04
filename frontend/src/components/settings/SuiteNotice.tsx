import { useEffect } from 'react'
import { ExternalLink, Info } from 'lucide-react'
import type { AiBackendInfo } from '@/api/settings'
import { useAiBackendStore } from '@/stores/aiBackend'
import { suiteNoticeFor, suitePageUrl } from '@/utils/suiteNotice'

/** The note at the top of a Settings → AI tab when AI runs through Gecko Suite. Nothing
 *  at all in `local` mode, or until the mode is known. */
export default function SuiteNotice({ section }: { section: string }) {
  const info = useAiBackendStore((s) => s.info)
  const load = useAiBackendStore((s) => s.load)
  useEffect(() => {
    void load()
  }, [load])

  return <SuiteNoticeView section={section} info={info} />
}

/** The notice for a known mode. Separate from the store so it can be rendered as given. */
export function SuiteNoticeView({ section, info }: { section: string; info: AiBackendInfo | null }) {
  const notice = suiteNoticeFor(section)
  if (!notice || info?.backend !== 'suite' || !info.suite_url) return null

  return (
    <div className="flex gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-100">
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="space-y-2">
        <p>{notice.text}</p>
        <p className="flex flex-wrap gap-x-4 gap-y-1">
          {notice.links.map((link) => (
            <a
              key={link.page}
              href={suitePageUrl(info.suite_url!, link.page)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-medium underline"
            >
              {link.label}
              <ExternalLink className="h-3 w-3" />
            </a>
          ))}
        </p>
      </div>
    </div>
  )
}
