---
name: test-in-sandbox-project
description: Use whenever you must try something out (create, delete or link a document, folder, attachment, import, translation, letter). Try it in the sandbox project, never in a real client or authority project.
scope: global
---

# Test in the sandbox project

## When to use
Any time a change or a fix needs a real try-out on documents or folders: creating, deleting, renaming or linking a document, an attachment, an import, a translation, a letter.

## Procedure
1. Find the sandbox: `GET /api/projects` and FIRST look for the owner's project named like "PROBA"/"TEST" (its slug is `sandbox`); use THAT one. Never open a second test project of your own while one exists.
2. If no such project exists at all, ask the owner; NEVER create a project yourself unless the owner explicitly asks for it. Never try things in a real project.
3. Create, delete, link whatever the test needs there. A few test documents may stay.
4. Every project works the same way, so a pass in the sandbox is a valid pass.

## Exception
Browser click-throughs (Playwright) and dashboard use click wherever they must; this rule is about document and file operations.

## Pitfalls
- A test in a real project can damage someone's real case file.
- The sandbox is shared: name your test documents so others see what they are.

## Check
The documents you touched during the test all sit under the sandbox project.
