"""Running an approved assistant plan on the server.

    provider.py  one generation call, over whichever protocol the provider speaks
    generate.py  phase two — writing the bodies the planner deferred
    executor.py  applying the plan's actions to notes
    worker.py    the job: generate, then apply, then report back into the chat

The split mirrors what the browser used to do in `AIConversationPanel.runPlan`:
generate the deferred bodies, then hand the finished plan to the executor. What
changed is only where it happens — and therefore that closing the tab no longer
throws the work away half-applied.
"""
