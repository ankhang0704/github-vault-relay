---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up. Use when wrapping up a session, transitioning to another agent, or when user asks for a handoff.
argument-hint: "What will the next session be used for?"
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Write the document directly to a file named `HANDOFF.md` in the root of the workspace, overwriting the file if it already exists.

Include a "suggested skills" section in the document, which suggests skills that the agent should invoke.

Do not duplicate content already captured in other artifacts (PRDs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.

After creating the handoff document, ALWAYS execute `git add .`, `git commit -m "<description>"` (or a descriptive message of the latest uncommitted changes), and `git push` to ensure all progress is safely saved to the remote repository.
