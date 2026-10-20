# InfoCapture

A lightweight, phone-first web app for capturing leads at conferences. Scan a badge QR code or snap a business card, add a few notes and tags, and the contact lands in an Excel workbook in your Microsoft 365.

- **Scan badge QR**: reads vCard, MECARD, BIZCARD, JSON and labelled QR codes instantly, on the phone, even offline.
- **Snap card**: takes a photo of a business card (or a badge without a usable QR). Claude reads it and fills in the form while you type notes. The photo is saved next to the workbook.
- **Type it in**: for everyone else.
- **Notes and quick tags** (Hot lead, Follow up, Send info...), plus the event name and who captured it.
- **Works offline.** Every capture is saved on the phone first and syncs when there is signal. Nothing waits on the network.
- **Excel in OneDrive or SharePoint.** One row per contact, updated in place when you edit. A team can share one workbook.
- Duplicate warning, CSV and vCard export, "Add to phone contacts", light and dark mode, installable to the home screen.

## How it fits together

```
 Phone (installed web app, GitHub Pages)
 ├─ IndexedDB ......................... every capture, offline-safe
 ├─ Microsoft sign-in (MSAL) .......... your M365 account
 ├─ Microsoft Graph ────────────────── Excel table "InfoCaptureLeads"
 │                                      + "Card Photos" folder beside the workbook
 └─ Card reader (AWS Lambda URL) ────── Claude reads card photos
        checks the M365 token,          (API key stays in AWS SSM)
        only your tenant gets in
```

There is no server for the data: the app writes to Excel directly with the signed-in person's own permissions. The only server piece is the small card reader, because the Claude API key cannot live in a browser.

| Path | What it is |
| --- | --- |
| `app/` | The web app. Plain HTML, CSS and JavaScript modules, no build step. Deploy this folder. |
| `app/config.js` | The one file to fill in for your organisation. |
| `backend/card-reader/` | The AWS Lambda (Node.js) and its CloudFormation template. |
| `tests/` | Unit tests and browser tests (fake camera, simulated Microsoft Graph). |

## Setup

You need: admin access to your Entra ID (Azure AD) tenant, an AWS account, and an Anthropic API key. Budget about 30 minutes.

### 1. Turn on GitHub Pages

1. In this repository: **Settings > Pages > Build and deployment > Source: GitHub Actions**.
2. Merge to `main`. The "Deploy app to GitHub Pages" workflow publishes `app/` to **https://travis-tlctech.github.io/infocapture/**.

Any static HTTPS host works (S3 + CloudFront, Azure Static Web Apps). The camera needs HTTPS.

### 2. Register the app in Microsoft Entra

In the [Entra admin center](https://entra.microsoft.com):

1. **App registrations > New registration**
   - Name: `InfoCapture`
   - Supported account types: **Accounts in this organizational directory only**
   - Redirect URI: platform **Single-page application (SPA)**, URI `https://travis-tlctech.github.io/infocapture/redirect.html`
   - Register.
2. On the app's **Overview**, copy the **Application (client) ID** and **Directory (tenant) ID**.
3. **Authentication**: add a second SPA redirect URI `http://localhost:8080/redirect.html` if you will run it locally.
4. **API permissions > Add a permission > Microsoft Graph > Delegated**: add `Files.ReadWrite.All` (`User.Read` is already there).
5. **Expose an API**
   - **Application ID URI > Add**, keep the suggested `api://<client id>`, Save.
   - **Add a scope**: name `access_as_user`, who can consent **Admins and users**, display name "Use the InfoCapture card reader", Enabled.
6. **API permissions > Add a permission > APIs my organization uses > InfoCapture > access_as_user**.
7. **Grant admin consent for <your org>** on the API permissions page, so nobody sees a consent prompt.

`Files.ReadWrite.All` lets the app open a workbook shared from SharePoint or a teammate's OneDrive. It acts only with the signed-in person's own access; it cannot see files they cannot already open. If everyone will only use a workbook in their own OneDrive, `Files.ReadWrite` is enough (then change `GRAPH_SCOPES` in `app/js/auth.js`).

### 3. Deploy the card reader on AWS

Skip this to start without automatic card reading: photos are still saved, and you type the fields.

1. Create an API key at [console.anthropic.com](https://console.anthropic.com) and store it in SSM Parameter Store (same region as the stack):

   ```bash
   aws ssm put-parameter --region us-east-2 \
     --name /infocapture/anthropic-api-key --type SecureString \
     --value 'sk-ant-...'
   ```

2. Deploy (needs Node 20+, the AWS CLI, and any S3 bucket for the code package):

   ```bash
   cd backend/card-reader
   TENANT_ID=<tenant id> CLIENT_ID=<client id> ARTIFACT_BUCKET=<bucket> ./deploy.sh
   ```

   It runs the tests, builds, deploys the `infocapture-card-reader` CloudFormation stack in `us-east-2`, and prints the **card reader URL**. Optional variables: `AWS_REGION`, `STACK_NAME`, `ALLOWED_ORIGINS` (default `https://travis-tlctech.github.io`; add `,http://localhost:8080` for local testing), `CLAUDE_MODEL`.

The Lambda rejects any request without a valid Microsoft 365 access token from your tenant carrying the `access_as_user` scope. The function URL allows browser calls only from `ALLOWED_ORIGINS`. To cap spend, set the stack's `ReservedConcurrency` parameter.

### 4. Fill in `app/config.js`

```js
export default {
  tenantId: '<Directory (tenant) ID>',
  clientId: '<Application (client) ID>',
  apiScope: '',               // blank = api://<clientId>/access_as_user
  cardReaderUrl: '<card reader URL from step 3>',
  workbook: '/InfoCapture/InfoCapture Leads.xlsx',
};
```

**Where contacts go (`workbook`):**

- **A path** such as `/InfoCapture/InfoCapture Leads.xlsx`: each person gets the workbook in their own OneDrive, created on their first sync.
- **A sharing link**, for one team workbook: create an empty workbook in SharePoint (or OneDrive), share it with the team with edit rights, use **Share > Copy link**, and paste the link here. The app adds the table on a blank "Leads" sheet, or on a new "InfoCapture" sheet if "Leads" already has data.

Commit and merge. Teammates then only open the app and sign in.

Prefer not to commit IDs? Leave `config.js` blank, enter the values on one phone under **Settings > Connection**, then use **Settings > Team setup > Copy setup link** and send that link to the team. It carries IDs and URLs only, never passwords or keys.

### 5. Install on phones

1. Open https://travis-tlctech.github.io/infocapture/ in Safari (iPhone) or Chrome (Android).
2. iPhone: **Share > Add to Home Screen**. Android: **Install app** from the menu. (Installed, the app opens full screen, works offline, and iOS keeps its storage.)
3. Tap **Sign in**, pick your work account.
4. Settings: set **Your name** and the **Current event**, then **Test connection**.

## At the conference

- Set the event once (tap the event bar on the home screen). It is stamped on every contact.
- **Scan badge QR**: hold the badge in the frame. Name, company, title, email and phone fill in. Add notes, tap tags, **Save**.
- **Snap card**: take the photo, start typing notes straight away. Fields fill in a few seconds later; highlighted fields came from the card, so check them.
- No signal? Keep going. The badge at the top shows how many are waiting, and they sync on their own.
- Tap any contact later to add notes. Edits update the same Excel row. Deleting a contact removes its row.

Many event badges only carry an attendee ID for the organiser's paid lead-retrieval app. When a QR has no contact details, the app says so: snap a photo of the badge instead.

## The spreadsheet

Table `InfoCaptureLeads`, one row per contact:

`Captured At, First Name, Last Name, Company, Title, Email, Phone, Tags, Notes, Event, Captured By, Source, Other Phone, Website, LinkedIn, Address, Other Info, Card Photo, QR Data, Updated At, ID`

- Sort, filter, add your own columns ("Owner", "Status"...). The app finds columns by header name and leaves cells in your extra columns alone. Keep the header names, and keep the **ID** column.
- **Card Photo** links to the photo in the "Card Photos" folder beside the workbook.
- Text that starts with `=`, `+`, `-` or `@` is stored as plain text, so a malicious QR code cannot inject a formula.

## Costs

- GitHub Pages, Microsoft Graph: no extra cost.
- AWS: Lambda and SSM standard parameters stay inside the free tier at conference volumes.
- Claude: the reader uses `claude-opus-5-5` at low effort, roughly 2 to 3 thousand tokens per card: about $0.02 per card at list price ($10 for 500 cards). Set `CLAUDE_MODEL=claude-haiku-5-5` when deploying for a much cheaper, slightly less accurate reader.

## Privacy and security

- Contact data lives on the phone (until synced) and in your Microsoft 365 tenant. There is no third-party database.
- Card photos and unrecognised QR text are sent to your card reader Lambda, which sends them to the Anthropic API to be read. Nothing is stored in AWS; its logs record the user's Entra object ID, token counts and timings, never contact details.
- The Claude API key never reaches a phone. Microsoft tokens are short-lived and cached in the browser by MSAL.
- **Settings > Remove synced contacts from this phone** clears the local copies after an event.

## Known limits

- **iPhone sign-in roughly once a day.** Microsoft limits browser-app refresh tokens to 24 hours, and Safari blocks the silent renewal. When it lapses, captures keep working and the app shows a **Sign in** button to resume syncing.
- **Two people editing the same row at the same moment**: the last save wins.
- This build has been tested against a simulated Microsoft Graph, a fake camera, and mocked Claude responses (see Tests). Do one real end-to-end capture after setup before relying on it at an event.

## Development

```bash
npm install
npm start            # http://localhost:8080 (camera works on localhost)
npm test             # unit tests: QR parsing, Excel sync, exports
npm run test:e2e     # browser tests; needs ffmpeg and Playwright's Chromium
cd backend/card-reader && npm install && npm test
```

- `npm run vendor` rebuilds `app/vendor/` (MSAL, jsQR) from the pinned versions.
- `npm run assets` regenerates the icons and the Excel template (needs Python with Pillow and openpyxl).
- When serving from somewhere other than GitHub Pages, replace `__BUILD__` in `app/sw.js` with a new value on each release so phones pick up updates (the Pages workflow does this).

### Card reader API

`POST <card reader URL>` with `Authorization: Bearer <M365 access token for api://<clientId>/access_as_user>`:

```json
{ "action": "card", "mediaType": "image/jpeg", "image": "<base64>" }
{ "action": "text", "text": "<raw QR text>" }
{ "action": "ping" }
```

Reply: `{ "ok": true, "fields": { "firstName", "lastName", "title", "company", "email", "phone", "phoneAlt", "website", "linkedin", "address", "other" } }` or `{ "ok": false, "error": "..." }`.
