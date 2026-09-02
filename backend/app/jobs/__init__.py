"""Background jobs.

    runner.py    the queue and worker threads every job kind shares
    registry.py  what each kind is called, how it serialises, how it cancels

The pattern started in `video/worker.py`, which explains its own reasoning: work
that takes minutes runs on a dedicated thread rather than through FastAPI's
BackgroundTasks, so a long render cannot starve request handling, can be
cancelled part-way, and is picked back up rather than left stuck at "processing"
when the process restarts. This package is that machinery pulled out so the next
kind of long-running work does not copy it a third time.
"""
