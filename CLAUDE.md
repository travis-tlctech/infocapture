# InfoCapture

Phone-first lead capture: scan a badge QR code or snap a business card, add notes and tags, and the contact lands in an Excel table in Microsoft 365. See README.md for setup and architecture.

## Asana (the plan of record)

- The plan is the Asana project "2-InfoCapture Tool" (https://app.asana.com/1/1211613993048758/project/1219707531039171). Asana is the plan; any internal to-do list mirrors it.
- Every task name starts with its ID: S<sprint>.<n>, subtasks S<sprint>.<n>.<m>, parking lot PL.<n>. Tasks sit in working order; if the order changes, reorder and renumber Asana first.
- "Next" in chat must be the first open task in Asana, by its ID. After a compaction or a new session, re-read Asana before naming it.
- Before starting a task, read its comments (Travis answers questions there; don't ask him to repeat answers in chat).
- Keep Status1 current on top-level tasks, with literal meanings (Not Started, Planned, In Progress, On Hold, Blocked, Completed): set it when work starts, stops, waits on Travis or an outside party (Blocked), or finishes. Leave Assignee and Due Date alone unless asked.
- Mark each subtask done as it finishes, with a short note on what was done and what is still open.
- Questions for Travis are comments that tag @Travis Cryan on the task they block, with the asks in bold and numbered; say it in chat too.
- Files Travis provides (sample badges, cards, handoff notes) go in the project folder, OneDrive-TLCTech/Tool Dev/InfoCapture Tool, not as Asana attachments. That OneDrive is in the TLC Tech tenant; the Microsoft 365 connector used so far signs in to TLC TRNG (Travis@TLCTRNG.com) and cannot see it, so ask Travis to paste or upload what's needed.

### Mechanics

- Status1 field `1211761155622080`. Options: Not Started `1218767488983987`, Planned `1211763512680320`, In Progress `1211763510783095`, On Hold `1211763510783096`, Blocked `1211763510783097`, Completed `1211763510783098`.
- Tag Travis in `html_text` with `<a data-asana-gid="1211614196498999"/>`.
- Sections: Sprint 0 `1219708887459765`, Sprint 1 `1219708887459768`, Sprint 2 `1219708887459771`, Sprint 3 `1219708887459774`, Sprint 4 `1219708887459777`, Parking Lot `1219708743920212`. Sections can be renamed, added and removed with update_project.
- Create top-level tasks one per call, never several in one call or in parallel: Asana runs a batch in parallel and the order comes out scrambled. New tasks append to the end of their section.
- A new subtask lands at the top of its parent, so create subtasks last to first. Re-attaching a subtask to the same parent does not move it.
- Comment and notes HTML allows only `<body>`, `<strong>`, `<em>`, `<u>`, `<s>`, `<code>`, `<ol>`, `<ul>`, `<li>`, `<a>`, `<blockquote>`, `<pre>` (notes also allow a few more). Any other tag, `<br/>` especially, breaks it. Use plain newlines. Write `>` as `&gt;` inside HTML. Comments cannot be edited or deleted through the tools.

## Development

- `npm install`, then `npm start` (http://localhost:8080), `npm test` (unit), `npm run test:e2e` (browser tests; needs ffmpeg and Playwright's Chromium).
- Card reader: `cd backend/card-reader && npm install && npm test`.
- The app in `app/` has no build step. `npm run vendor` rebuilds `app/vendor/` from pinned versions; `npm run assets` rebuilds icons and the Excel template.
- Run the unit, browser and card reader tests before every push. CI runs all three on every branch except main; the Pages workflow deploys main.
