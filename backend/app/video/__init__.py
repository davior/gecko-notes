"""Article-to-video rendering.

Turns a note's BlockNote document into a narrated MP4: each image/video in the
document becomes the background for the text beneath it, that text is narrated
with the account's TTS voice, and the resulting shots are stitched into one file.

Module layout:
    options.py    RenderOptions + the aspect/resolution/quality tables
    segmenter.py  BlockNote JSON -> [Shot]                       (pure)
    compose.py    Pillow: title cards, overlay PNGs, backgrounds
    narration.py  chunking, TTS, silence padding, durations, SRT
    ffmpeg.py     argv + filtergraph builders, run/probe helpers  (pure builders)
    renderer.py   job orchestration
    worker.py     the single render worker thread
"""
