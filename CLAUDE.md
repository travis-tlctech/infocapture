# InfoCapture

Phone-first lead capture: scan a badge QR code or snap a business card, add notes and tags, and the contact lands in the team list in Supabase, which the team downloads as an Excel spreadsheet. See README.md for setup and architecture.

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

## Supabase

- Project: https://vdcwyqththjkgbskthcb.supabase.co (Travis's Pro organization, region East US / Ohio). The URL and the publishable key are in `app/config.js`; neither is a secret.
- Never ask for, read or handle the secret key, the service role key or the database password. Nothing in this repo needs them.
- Schema and access rules live in `supabase/setup.sql`, written so it is safe to run again. Travis runs it in the dashboard's SQL Editor; say exactly what to paste. `supabase/test/run.sh` checks it and the rules on a local PostgreSQL; run it after any change.
- Logins: Travis creates each one in the dashboard and adds it to the team with `supabase/add-team-member.sql`. Public sign-ups stay off. Passwords are never posted in chat, Asana or email.

## Anthropic API key (Travis's rules)

- Never ask Travis for the key, and never read it. He never pastes it into chat, Asana or email.
- He enters it himself at a hidden prompt in the Terminal app: `backend/card-reader/set-key.sh` (it guards against an empty capture). Check the stored key only by its metadata (name, dates, version count), never its value.
- The key never goes into browser or phone code; only the card reader Lambda reads it, from AWS Secrets Manager.
- AWS: account TLC Tech, CLI profile `tlc-tech`, region us-east-2. Leave the `default` profile alone, and ask Travis before creating any new AWS resource.
- Cloud sessions have no working AWS credentials. Travis runs `set-key.sh` and `bootstrap.sh` on his Mac; after that the card reader deploys from GitHub Actions ("Deploy card reader", with the account number), through the role `infocapture-github-deploy` (no stored AWS keys).
- Claude Console organization "TLC Tech" holds the shared monthly API credit; this tool's key is `info-capture`.
- Logs record sizes, timing and token counts only, never what a card says. Background: Anthropic_API_Handoff_for_TLC_Info_Capture_Tool.md in the project folder.

## Development

- `npm install`, then `npm start` (http://localhost:8080), `npm test` (unit), `npm run test:e2e` (browser tests; needs ffmpeg and Playwright's Chromium). The browser tests replace `config.js` and block every real Supabase address, so they never touch the live project.
- Card reader: `cd backend/card-reader && npm install && npm test`. Database: `supabase/test/run.sh`.
- The app in `app/` has no build step. `npm run vendor` rebuilds `app/vendor/` (supabase-js, jsQR) from pinned versions; `npm run assets` rebuilds the icons.
- Run the unit, browser, card reader and database tests before every push. CI runs all four on every branch except main; the Pages workflow deploys main.
- Work happens on the claude branch. Update `main` (which publishes the app) only with Travis's OK.
