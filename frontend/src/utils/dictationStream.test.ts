import { describe, expect, it } from 'vitest'
import { streamUrl } from '@/utils/dictationStream'

describe('where live dictation streams', () => {
  it('goes to Gecko Suite when AI runs through it, naming Notes and the chosen model', () => {
    // SN-9: the suite holds the Deepgram key and counts the minutes under Notes.
    expect(streamUrl('https://suite.example.test/', 'a b', 'nova-3', 'wss://notes/api')).toBe(
      'wss://suite.example.test/api/v1/ai/speech/stt/stream?app=notes&token=a+b&model=nova-3',
    )
  })

  it('stays on Notes’ own relay otherwise', () => {
    expect(streamUrl(null, 't', 'nova-3', 'wss://notes.example.test/api')).toBe(
      'wss://notes.example.test/api/stt-stream/ws?token=t',
    )
  })
})
