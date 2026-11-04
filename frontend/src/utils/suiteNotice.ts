/**
 * What Settings → AI says about Gecko Suite, in one place so the wording is checked against
 * what the backend really does (see `app/suite.py` in Notes). Each notice names what moved,
 * what still applies on the page, and where to go.
 */
export type SuitePage = 'providers' | 'routing' | 'search' | 'usage'

export interface SuiteNoticeContent {
  text: string
  links: { label: string; page: SuitePage }[]
}

/** A page on the suite. The suite's own routes are `/providers`, `/routing`, `/search`... */
export function suitePageUrl(base: string, page: SuitePage): string {
  return `${base.replace(/\/+$/, '')}/${page}`
}

const NOTICES: Record<string, SuiteNoticeContent> = {
  providers: {
    text:
      'AI chat runs through Gecko Suite, which holds the API keys and counts the spend. This list only ' +
      'tells Notes which providers and models you can pick. For one to work, the same vendor and model ' +
      'must also be set up in the suite; a key saved here is not used. The fal.ai generation key under ' +
      'Media Provider below is not used either (its admin key still feeds the usage readouts on the ' +
      'Images tab).',
    links: [{ label: 'Providers in Gecko Suite', page: 'providers' }],
  },
  assistant: {
    text:
      'Web search runs through Gecko Suite, which uses your own search backend, else a shared one, else ' +
      'DuckDuckGo. The search backend below no longer applies. Prompts, the prefilled response and the ' +
      'summary prompt are still managed here.',
    links: [{ label: 'Search in Gecko Suite', page: 'search' }],
  },
  speech: {
    text:
      'Read-aloud, narration, dictation and recording transcription run through Gecko Suite. Its ' +
      'speech.tts routing decides the voice model (a voice you pick here is used if that model offers ' +
      'it), and transcription uses a Deepgram provider there, so the engine and model choices below no ' +
      'longer apply. Live transcription and voice mode still use the Deepgram key saved here.',
    links: [
      { label: 'Task routing in Gecko Suite', page: 'routing' },
      { label: 'Providers in Gecko Suite', page: 'providers' },
    ],
  },
  images: {
    text:
      'Image generation runs through Gecko Suite, which holds the fal.ai key and bills it. The model ' +
      'list and sizes below still apply. The usage and balance readouts use the fal keys saved here, so ' +
      'they will not show what the suite spent.',
    links: [{ label: 'Providers in Gecko Suite', page: 'providers' }],
  },
  usage: {
    text:
      'Chat, speech, search and image usage is recorded by Gecko Suite. This page shows only what Notes ' +
      'records itself: history from before the suite, and live transcription.',
    links: [{ label: 'Usage in Gecko Suite', page: 'usage' }],
  },
}

/** The notice for a Settings → AI tab, or null for a tab the suite does not change. */
export function suiteNoticeFor(section: string): SuiteNoticeContent | null {
  return NOTICES[section] ?? null
}
