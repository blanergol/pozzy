# Pozzy

**An unofficial cross-platform mobile client for the self-hosted [Poznote](https://github.com/timothepoznanski/poznote) note-taking server — iOS, Android, and a one-command web build for quick testing on Windows.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-iOS%20%7C%20Android%20%7C%20Web-blue.svg)](#getting-started)
[![Expo SDK 57](https://img.shields.io/badge/Expo%20SDK-57-000020.svg?logo=expo)](https://expo.dev)
[![React Native 0.86](https://img.shields.io/badge/React%20Native-0.86-61dafb.svg?logo=react)](https://reactnative.dev)
[![API coverage: 100 endpoints](https://img.shields.io/badge/API%20coverage-100%20endpoints-green.svg)](docs/API-COVERAGE.md)

Pozzy talks to your own Poznote server over its REST API (HTTP Basic Auth + `X-User-ID`) — no cloud, no third parties, your notes stay on your hardware. Built with React Native + Expo (Node.js toolchain), so development and testing run entirely on Windows.

<p>
  <img src="docs/screenshots/notes-dark.png" width="250" alt="Notes list (dark theme)">
  &nbsp;
  <img src="docs/screenshots/folders-dark.png" width="250" alt="Folders (dark theme)">
  &nbsp;
  <img src="docs/screenshots/settings-dark.png" width="250" alt="Settings (dark theme)">
</p>

## Features

**Connection**
- First-launch server setup with connection validation (credentials and `/notes` access are checked before saving)
- Multiple saved servers: add, edit, switch, and remove connection profiles
- `X-User-ID` auto-detected from your credentials (`GET /users/me`); manual override for admins
- Light / dark / system theme, persisted
- **Two UI languages: English and Russian** — auto-detected from the system locale, with a manual override in Settings
- **App lock with biometrics or device PIN** (Face ID / fingerprint / system passcode), relocks after 30 s in background (native only)

**Notes**
- List with instant search, workspace and folder filters, pull-to-refresh, and sort by last update
- Multi-select mode: long-press a note → checkboxes, select all, bulk delete
- Editor with **edit-lock** support (safe co-editing with the web UI: acquire, heartbeat, release, conflict banner)
- Create, edit (heading, tags, content), favorite, soft-delete
- Duplicate, convert Markdown ↔ HTML, move to folder
- Public share links (create / revoke / send)
- Reminders with quick intervals
- Version history (snapshots) with one-tap restore
- Backlinks viewer
- Attachments: upload, open, delete

**Organization**
- Folders: note counts, create, rename, empty, delete
- Trash: restore, permanent delete, empty
- Workspaces: quick switcher in the notes list
- Notifications (reminder alerts) with an unread badge

**Server management (in Settings)**
- Server version and update check
- Git Sync: status, connection test (with decoded server errors), push, pull
- Backups: list, create, delete
- Active public share links

**API coverage:** 100 client calls, all verified against the Poznote OpenAPI spec — see [docs/API-COVERAGE.md](docs/API-COVERAGE.md) (including a list of spec ↔ server discrepancies found along the way).

## Getting started

### Prerequisites

- Node.js 20+ and npm
- [Expo Go](https://expo.dev/go) on your phone (App Store / Google Play) for on-device testing
- Network access to your Poznote server from the device/browser

### Run

```bash
git clone https://github.com/blanergol/pozzy.git pozzy
cd pozzy
npm install
npm start
```

Then pick your target:

- **Phone (recommended):** scan the QR code with Expo Go. Phone and PC must be on the same network.
- **Browser on Windows:** press `w` (or `npm run web`) — the app opens as a web page.
- **Android emulator:** press `a` (requires Android Studio with an emulator).

### First-launch setup

1. **Server URL** — e.g. `https://poznote.example.com` (the `https://` scheme is added automatically if omitted).
2. **Login and password** — your Poznote credentials (HTTP Basic Auth).
3. **Profile ID** — leave empty: it is auto-detected from your credentials. Fill it in manually only to act as another profile (requires admin credentials).

Tap **“Check & save”**: the app validates the credentials and `/api/v1/notes` access, then stores the profile. You can save multiple servers and switch between them in **Settings → Servers**.

## Testing

```bash
npx tsc --noEmit                    # TypeScript
npx expo export                     # production bundles for web/iOS/Android
node scripts/mock-server.js 8901 &  # stateful mock of the Poznote API
node scripts/e2e.js                 # end-to-end walkthrough (needs expo web on :8081) — 40 checks
```

The E2E suite (`scripts/e2e.js`) drives the real app in a browser via Playwright against a full stateful mock of the Poznote API (`scripts/mock-server.js`): connection, search, workspaces, notifications, every editor action, folders, trash, multi-select, and settings. Reset the mock between runs with `GET /__reset`. For the demo dataset used in the screenshots above, run the mock with `node scripts/mock-server.js 8902 showcase` (and `scripts/screenshots.js` to regenerate them).

## Project structure

```
App.tsx                              — navigation (themed header), app entry
src/theme/ThemeContext.tsx           — light/dark palettes, system theme
src/i18n/                            — ru/en dictionaries + provider (system locale, persisted)
src/api/client.ts                    — Poznote HTTP client (Basic Auth + X-User-ID), 100 API calls
src/api/types.ts                     — API types (matching real server responses)
src/context/SettingsContext.tsx      — server profiles, active server, theme, workspace
src/storage/settings.ts              — persistence (AsyncStorage): servers, theme, workspace
src/components/ActionSheet.tsx       — bottom-sheet menus (Alert is limited on Android)
src/components/DialogProvider.tsx    — cross-platform dialogs (RN-web Alert is a no-op)
src/components/AttachmentsModal.tsx  — note attachments
src/screens/SettingsScreen.tsx       — servers, theme, system, Git Sync, backups, share links
src/screens/NotesListScreen.tsx      — notes list (search, filters, multi-select, badge)
src/screens/NoteEditorScreen.tsx     — editor (edit-lock, actions, snapshots, backlinks)
src/screens/FoldersScreen.tsx        — folders
src/screens/TrashScreen.tsx          — trash
src/screens/NotificationsScreen.tsx  — notifications (reminders)
scripts/mock-server.js               — stateful Poznote API mock (port 8901)
scripts/e2e.js                       — Playwright E2E suite
docs/openapi.yaml                    — vendored Poznote OpenAPI spec
docs/API-COVERAGE.md                 — API coverage checklist + spec/server discrepancies
```

## Troubleshooting

**Self-signed / internal CA certificates.** If your server uses HTTPS with a private CA, that CA must be trusted by the phone, or requests will fail. In a browser, opening the server URL once and accepting the certificate is enough.

**CORS (web builds only).** Poznote's preflight response does not include `X-User-ID` in `Access-Control-Allow-Headers` (upstream bug, `src/api/v1/index.php`). Browsers therefore block data endpoints; native apps are unaffected. The one-line fix on the server:

```bash
docker exec <poznote-container> sed -i "s|Access-Control-Allow-Headers: Content-Type, Authorization|Access-Control-Allow-Headers: Content-Type, Authorization, X-User-ID|" /var/www/html/api/v1/index.php
```

## Known spec discrepancies

While building the client we found several places where Poznote's OpenAPI spec differs from the actual server responses (field names, status codes, CORS headers). The client follows the real server behavior; all findings are documented in [docs/API-COVERAGE.md](docs/API-COVERAGE.md) and are good candidates for upstream fixes.

## Contributing

Issues and pull requests are welcome. Please run `npx tsc --noEmit` and the E2E suite before submitting a PR.

## Support the project

Pozzy is free and open source. If it saves you time, you can support development with a USDT transfer on the TON network (no memo required):

```
UQBC2cFoZ94jsJil-AhmL2HalKZoRikv50UVtzAdSRj05qCk
```

## Acknowledgments

- [Poznote](https://github.com/timothepoznanski/poznote) — the self-hosted note-taking server this client is built for (all credit for the API and server to its authors).
- Built with [Expo](https://expo.dev) and [React Native](https://reactnative.dev).

## License

[MIT](LICENSE) © Pozzy contributors. This is an unofficial client and is not affiliated with the Poznote project.
