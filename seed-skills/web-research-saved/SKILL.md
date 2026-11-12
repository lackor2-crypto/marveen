---
name: web-research-saved
description: Use after any web search or page read. The system saves the result into the Research by itself; this tells you what is left for you (Context file, To-dos) and what to do when the web was read another way.
scope: global
---

# Web results go to the Research

## When to use
Every time you used WebSearch or WebFetch, or read a web page by any other means.

## What the system does
A PostToolUse hook (`scripts/hooks/web-research-save.py`) posts each WebSearch / WebFetch result to `POST /api/research/capture`. It is written as `research/web-<topic>.md` in YOUR agent folder, never overwriting, never twice for the same text. The Research page and the Workbench list it. The hook tells you the file name.

## What is left for you
1. Working on a work item: write the facts you found and their source into its Context file (`context.append`).
2. Write the next steps and open points into its To-dos.
3. Read the web by another tool (browser, curl)? Save the essence yourself: `research.save` (project assistant) or a file under your `research/` folder.

## Pitfalls
- The hook never blocks and fails silently if the dashboard is down: if no "saved" note came back, check the Research page before trusting it is there.
- Kill switch for a test run: `MARVEEN_WEB_RESEARCH_SAVE=0`.
