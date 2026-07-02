import { createReactBlockSpec } from '@blocknote/react'

// Custom BlockNote block that embeds a stored audio file (e.g. a saved dictation
// recording or a generated read-aloud clip) as an inline HTML5 player. Named
// `audioFile` rather than `audio` so it sits alongside BlockNote's built-in file
// blocks instead of overriding them. Stores only the media URL and a label; the
// file itself lives under /media and is uploaded separately.
export const audioBlock = createReactBlockSpec(
  {
    type: 'audioFile',
    propSchema: {
      url: { default: '' },
      name: { default: '' },
    },
    content: 'none',
  },
  {
    render: (props) => (
      <div contentEditable={false} className="my-2">
        {props.block.props.name && (
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-1 truncate">
            {props.block.props.name}
          </div>
        )}
        <audio controls src={props.block.props.url} className="w-full max-w-md" />
      </div>
    ),
  },
)()
