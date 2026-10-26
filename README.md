# InfoCapture

A lightweight, phone-first web app for capturing leads at conferences. Scan a badge QR code or snap a business card, add a few notes and tags, and the contact lands in your team's shared list, which anyone on the team can download as an Excel spreadsheet.

- **Snap card** (the big button): takes a photo of a business card (or a badge without a usable QR). Claude reads it and fills in the form while you type notes. The photo is kept with the contact.
- **Scan QR**: reads vCard, MECARD, BIZCARD, JSON and labelled badge QR codes instantly, on the phone, even offline.
- **Type it in**: for everyone else.
- **Notes and quick tags** (Hot lead, Follow up, Send info...), plus the event name and who captured it.
- **Works offline.** Every capture is saved on the phone first and syncs when there is signal. Nothing waits on the network.
- **One team list.** Each person signs in with their own login (no Microsoft or Google account needed), and everyone's captures land in one list in Supabase. Edits update the same contact.
- **Team spreadsheet**: Settings > Download spreadsheet gives an Excel file of everyone's contacts, with links to the card photos.
- Duplicate warning, CSV and vCard export, "Add to phone contacts", light and dark mode, installable to the home screen.
- Styled to the TLC_TRNG brand: navy, azure and cyan, Montserrat and Open Sans; the InfoCapture icon glows cyan on navy (see `brand/README.md`).

## How it fits together

```
 Phone (installed web app, GitHub Pages)
 ├─ IndexedDB ......................... every capture, offline-safe
 ├─ Supabase sign-in .................. each person's own login
 ├─ Supabase database ──────────────── table "leads" (team members only)
 │                                      + private "card-photos" bucket
 └─ Card reader (AWS Lambda URL) ────── Claude reads card photos
        checks the Supabase sign-in     (API key stays in AWS
        and team membership              Secrets Manager)
```

The app talks to Supabase directly with the person's own sign-in. Database rules (row-level security) let only people on the team read or write contacts and photos. The only server piece is the small card reader, because the Claude API key cannot live in a browser.

| Path | What it is |
| --- | --- |
| `app/` | The web app. Plain HTML, CSS and JavaScript modules, no build step. Deploy this folder. |
| `app/config.js` | The one file to fill in: the Supabase project URL and publishable key, and the card reader URL. |
| `brand/` | TLC_TRNG wordmark masters for the Settings sign-off (`npm run assets`). |
| `supabase/` | `setup.sql` (tables, rules and photo bucket), `add-team-member.sql`, and their tests. |
| `backend/card-reader/` | The AWS Lambda (Node.js), its CloudFormation template, and the deploy scripts. |
| `tests/` | Unit tests and browser tests (fake camera, simulated Supabase). |

## Setup

You need: a Supabase project, an AWS account for the card reader, and an Anthropic API key. Budget about 30 minutes.

### 1. Turn on GitHub Pages

1. In this repository: **Settings > Pages > Build and deployment > Source: GitHub Actions**.
2. **Settings > Environments > github-pages**: allow the `main` branch to deploy.
3. Merge to `main`. The "Deploy app to GitHub Pages" workflow publishes `app/` to **https://travis-tlctech.github.io/infocapture/**.

Any static HTTPS host works. The camera needs HTTPS.

### 2. Set up Supabase

In the [Supabase dashboard](https://supabase.com/dashboard), in your project:

1. **SQL Editor > New query**: paste [`supabase/setup.sql`](supabase/setup.sql) and **Run**. It creates the `leads` table, the `team_members` table, the private `card-photos` bucket, and the rules that keep both to team members. It is safe to run again.
2. **Authentication > Sign In / Providers**: turn off **Allow new users to sign up**. Logins are created only by you.
3. **Authentication > Users > Add user > Create new user** for each person, with a password and **Auto Confirm User** ticked. Give each person their password privately (not in chat, Asana or email).
4. **SQL Editor**: run [`supabase/add-team-member.sql`](supabase/add-team-member.sql) once per person, with their email in place of `person@example.com`. A login that is not on the team can sign in but sees and saves nothing; the app says so.

Contacts can also be viewed in **Table Editor > leads**, and card photos in **Storage > card-photos**.

### 3. Deploy the card reader on AWS

Skip this to start without automatic card reading: photos are still saved, and you type the fields.

The reader uses Claude through Anthropic's API, set up the same way as TrainMe's certificate reader. It runs in the TLC Tech AWS account, CLI profile `tlc-tech`, region `us-east-2`. The scripts use that profile and leave `default` alone.

1. **Create a key for this tool.** In the Claude Console organization **TLC Tech**, create an API key named `info-capture`. It draws on the same monthly credit as TrainMe, but a key per tool shows usage per tool and can be revoked on its own.

2. **Store it in AWS Secrets Manager**, in the Terminal app (never paste the key into a chat, Asana or email):

   ```bash
   git clone https://github.com/travis-tlctech/infocapture.git
   cd infocapture/backend/card-reader
   ./set-key.sh
   ```

   It asks for the key at a hidden prompt, refuses an empty paste, stores it as the secret `infocapture/anthropic-api-key` (about $0.40 a month), and shows only its metadata. Run it again to replace the key; the Lambda picks up the new one after its next 401.

3. **Let GitHub deploy it** (once), in the same folder:

   ```bash
   ./bootstrap.sh
   ```

   It creates the `infocapture-deploy-access` stack: an S3 bucket for code packages, and the role `infocapture-github-deploy`, which only this repository's `card-reader` GitHub environment can use (GitHub signs in to AWS with a short-lived token; no AWS keys are stored in GitHub). The role can manage only the card reader stack and its own Lambda, role, function URL and logs, and can see only that the API key exists, never its value. It prints the AWS account number.

4. **Deploy**: **Actions > Deploy card reader > Run workflow**, with the account number. It runs the tests, builds, deploys the `infocapture-card-reader` stack (a Lambda, its role, a function URL and a log group), and shows the **card reader URL** in the run's summary.

   To deploy from your own computer instead: `./deploy.sh` (needs Node 20+ and the AWS CLI). Optional variables: `AWS_PROFILE`, `AWS_REGION`, `STACK_NAME`, `ARTIFACT_BUCKET`, `ALLOWED_ORIGINS` (default `https://travis-tlctech.github.io`; add `,http://localhost:8080` for local testing), `CLAUDE_MODEL`.

The Lambda answers only requests carrying a valid Supabase sign-in for your project, from a person on the team. The function URL allows browser calls only from `ALLOWED_ORIGINS`. To cap spend, set the stack's `ReservedConcurrency` parameter.

**What the reader does with a card.** It reports exactly what is printed (it never corrects spelling), gives one entry per person, puts handwritten notes in Other Info, and ignores any text in the photo that is addressed to it. It also says how sure it is: the form marks fields it was unsure of with **check**, and offers to add a second person on the same card as a separate contact. A card it cannot read (including a refusal) shows "Couldn't read this card" so you type the fields from the photo; that is never an error.

### 4. Fill in `app/config.js`

```js
export default {
  supabaseUrl: 'https://<project ref>.supabase.co',   // Project Settings > API
  supabaseKey: 'sb_publishable_...',                  // Project Settings > API Keys
  cardReaderUrl: '<card reader URL from step 3>',
};
```

None of these are secrets: the publishable key is made for browsers, and the database rules decide what it can reach. Never put the secret key or the database password here. Commit and merge; teammates then only open the app and sign in.

Prefer not to commit them? Leave `config.js` blank, enter the values on one phone under **Settings > Connection**, then use **Settings > Team setup > Copy setup link** and send that link to the team. It carries the URLs and the publishable key only, never a password.

### 5. Install on phones

1. Open https://travis-tlctech.github.io/infocapture/ in Safari (iPhone) or Chrome (Android).
2. iPhone: **Share > Add to Home Screen**. Android: **Install app** from the menu. (Installed, the app opens full screen, works offline, and iOS keeps its storage.)
3. **Settings > Account**: sign in with your email and password. You stay signed in on that phone until you sign out.
4. Settings: set **Your name** and the **Current event**, then **Test connection**.

The first sync after signing in on a phone (a new phone, the app newly added to the Home Screen after using it in Safari, or signing in again) brings back the contacts that login captured, from the team list, and fills in an empty name and event from the latest one. Card photos of those contacts show from the team list when there is a connection.

## At the conference

A one-page version for whoever staffs the booth, with a QR code that opens the app: [docs/booth-guide/InfoCapture-booth-guide.pdf](docs/booth-guide/InfoCapture-booth-guide.pdf). Edit `docs/booth-guide/booth-guide.html` and run `npm run guide` to rebuild it.

- Set the event once (tap the event bar on the home screen). It is stamped on every contact.
- **Snap card**: take the photo, start typing notes straight away. Fields fill in a few seconds later; highlighted fields came from the card, so check them.
- **Scan QR**: hold the badge's QR code in the frame. Name, company, title, email and phone fill in. Add notes, tap tags, **Save**. If the camera picture doesn't appear, tap **Tap to start the camera**.
- No signal? Keep going. The badge at the top shows how many are waiting, and they sync on their own.
- Tap any contact later to add notes. Edits update the same contact in the team list. Deleting a contact removes it (and its photo) from the team list.

Many event badges only carry an attendee ID for the organiser's paid lead-retrieval app. When a QR has no contact details, the app says so: snap a photo of the badge instead.

## The team spreadsheet

**Settings > Download spreadsheet** builds an Excel file of everyone's contacts, with one table (`InfoCaptureLeads`, filter buttons on every column):

`Captured At, First Name, Last Name, Company, Title, Email, Phone, Tags, Notes, Event, Captured By, Source, Other Phone, Website, LinkedIn, Address, Other Info, Card Photo, QR Data, Updated At, ID`

- **Card Photo** links open the photo for 7 days; download again for fresh links. The photos stay private in Supabase.
- Every cell is plain text, a date or a link, so a malicious QR code cannot inject a formula. (The CSV export marks risky text with a leading apostrophe for the same reason.)
- The spreadsheet is a copy. Changes made in it do not flow back; edit contacts in the app.

## Costs

- GitHub Pages: free. Supabase: covered by your Pro plan; InfoCapture's data is tiny.
- AWS: the Secrets Manager secret is about $0.40 a month; the Lambda and the deploy bucket stay at or near zero at conference volumes.
- Claude: the reader uses `claude-opus-5-5` at low effort, about 1.5 to 2 cents a card (TrainMe measures about 1.6 cents per certificate page), so a conference's worth is a few dollars out of the monthly API credit shared with TrainMe. Set `CLAUDE_MODEL=claude-haiku-5-5` when deploying for a much cheaper, slightly less accurate reader.

## Privacy and security

- Contact data lives on the phone (until synced) and in your Supabase project. Only signed-in team members can read or write it; public sign-ups are off, and the publishable key alone reaches nothing (`supabase/test/run.sh` checks these rules).
- Card photos and unrecognised QR text are sent to your card reader Lambda, which sends them to the Anthropic API to be read under Anthropic's commercial API terms. Nothing is stored in AWS; its logs record only sizes, timings and token counts, never what a card says.
- The Claude API key never reaches a phone: it lives in AWS Secrets Manager and is entered only at a hidden Terminal prompt. Deploys use short-lived GitHub credentials, not stored AWS keys.
- **Settings > Remove synced contacts from this phone** clears the local copies after an event. They come back from the team list the next time that login signs in on the phone.

## Known limits

- **Two people editing the same contact at the same moment**: the last save wins. (Normally only the phone that captured a contact edits it.)
- Changes made to a row in the Supabase dashboard are overwritten if the contact is later edited on the phone that captured it.
- This build has been tested against a simulated Supabase, a fake camera, mocked Claude responses, and the database rules on a local PostgreSQL (see Tests). Do one real end-to-end capture after setup before relying on it at an event.

## Development

```bash
npm install
npm start            # http://localhost:8080 (camera works on localhost)
npm test             # unit tests: QR parsing, team list store, spreadsheet, exports
npm run test:e2e     # browser tests; needs ffmpeg and Playwright's Chromium
supabase/test/run.sh # setup.sql and the access rules on a throwaway local PostgreSQL
cd backend/card-reader && npm install && npm test
```

- `npm run vendor` rebuilds `app/vendor/` (supabase-js, jsQR) from the pinned versions.
- `npm run assets` regenerates the icons and logo images from `brand/` (needs Python with Pillow).
- When serving from somewhere other than GitHub Pages, replace `__BUILD__` in `app/sw.js` with a new value on each release so phones pick up updates (the Pages workflow does this).

### Card reader API

`POST <card reader URL>` with `Authorization: Bearer <Supabase access token>`:

```json
{ "action": "card", "mediaType": "image/jpeg", "image": "<base64>" }
{ "action": "text", "text": "<raw QR text>" }
{ "action": "ping" }
```

Reply:

```json
{
  "ok": true,
  "contacts": [
    { "fields": { "firstName": "", "lastName": "", "title": "", "company": "", "email": "", "phone": "", "phoneAlt": "", "website": "", "linkedin": "", "address": "", "other": "" },
      "confidence": 0.9, "unsure": ["email"] }
  ],
  "fields": { "...": "the first contact's fields" },
  "unreadable": ""
}
```

`contacts` has one entry per person. `unreadable` is empty, or says why nothing came back (`declined`, `cut_off`, `no_answer`, `nothing_found`). Errors are `{ "ok": false, "error": "..." }`: 401 for a missing or invalid sign-in, 403 for a login that is not on the team.
