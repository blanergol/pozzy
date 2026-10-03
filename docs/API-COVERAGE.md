# Poznote API coverage

Source of truth: `docs/openapi.yaml`, a verbatim copy of `src/public/api-docs/openapi.yaml` from the
[Poznote repository](https://github.com/timothepoznanski/poznote), synced on 2026-10-03 from Poznote
6.107.2-beta (the spec itself reports `version: 2.0.0`).

Legend: ✅ implemented and used (UI or AI-agent tool) · 🔶 implemented in the client, no caller yet ·
❌ deliberately skipped · ⬜ not implemented.

**Summary.** `src/api/client.ts` issues 104 HTTP calls: 100 through the `request` helper and 4 raw
`fetch` calls for multipart uploads and binary downloads. 103 of them match an operation of the current
spec by path and method (checked by script); the remaining one, `POST /notes/{id}/create-template`,
targets an endpoint Poznote removed in 6.83.0 (see below). The spec describes **156 operations over
119 paths**; the client covers **103** of them, the other 53 are listed under
[Not covered](#not-covered-53-operations).

## Spec ↔ server discrepancies: resolved upstream

The client was originally written against the real controller behavior (`src/api/v1/controllers/*.php`)
because the OpenAPI spec of the time did not match it. Poznote **6.101.0** (2026-09-30) fixed the spec
and the server. Status re-checked against 6.107.2-beta:

| # | Original finding | Poznote ≥ 6.101.0 | Client |
|---|---|---|---|
| 1 | `GET /notes` returns metadata only, no `entrycontent`; the `Note` schema was wrong | Spec fixed: the `Note` schema now states that `GET /notes` "lists metadata only, without content or version" | `NoteListItem` never had a content field, no change |
| 2 | `GET /notes/{id}` returns the body in `content`, not `entrycontent`; `favorite` and `trash` were missing from the response | Spec fixed: `Note.content` is documented as "only returned by GET /notes/{id}". The server now also returns `favorite` (0/1). `trash` is still not returned and is no longer in the schema | `NoteDetails.content` unchanged; `favorite` added as an optional field |
| 3 | Edit-lock conflict: the server answers **423**, the spec said 409 | Spec fixed: `423` is documented on `PATCH` and `DELETE /notes/{id}`; 409 now means a version conflict (`if_version` / `If-Match`) | 423 is a lock conflict; 409 is one only when the response carries `lock` details (old-spec servers), otherwise it is reported as a plain API error |
| 4 | CORS: `Access-Control-Allow-Headers` did not include `X-User-ID`, so browser clients could not call data endpoints | Server fixed: the preflight now allows `Content-Type, Authorization, X-User-ID, X-Editor-Session-ID, X-Poznote-OTP, If-Match, If-None-Match` | The web build works against ≥ 6.101.0 without patching the server; the README keeps the one-line fix for older servers |
| 5 | `GET /folders` enables the tree mode with `hierarchical=true`, the spec said `tree` | Spec fixed (listed in the 6.101.0 release notes) | No change |
| 6 | `GET /workspaces`: no `note_count` in the response although the `Workspace` schema had it; `username` and `acting_as` were undocumented | Spec fixed: `note_count` removed, `username` and `acting_as` documented, `color` / `color_hex` added to `Workspace` | `Workspace` type unchanged |

**Removed upstream.** `POST /notes/{id}/create-template` disappeared in Poznote 6.83.0 (2026-09-09), when
templates became "any note kept in a folder or workspace named *Templates*"; `GET /notes/templates`
(6.86.0) lists them. The client method `createTemplateFromNote` has no UI and no callers and returns 404
on current servers. Pozzy's own "New from template" feature stores templates locally and does not depend
on this endpoint.

**Renamed in the spec only.** Folder sharing moved from `/folders/{folderId}/share` to `/folders/{id}/share`;
the runtime path is the same.

## Notes — 22 of 34 operations, plus 4 of 4 snapshots

| Endpoint | Status | Client | Where |
|---|---|---|---|
| GET /notes | ✅ | `listNotes` (all filters) | notes list and search, offline repository, AI agent |
| POST /notes | ✅ | `createNote` | "+" button, AI agent |
| GET /notes/resolve | 🔶 | `resolveNote` | — |
| GET /notes/search | ✅ | `searchNotes` | AI agent (`search_notes`); the UI searches through `listNotes(search=)` |
| GET /notes/search/ids | ⬜ | — | added in Poznote 6.103.0 |
| GET /notes/with-attachments | 🔶 | `listNotesWithAttachments` | — |
| GET /notes/templates | ⬜ | — | server-side templates (6.86.0); Pozzy keeps its own local templates |
| GET /notes/{id} | ✅ | `getNote` | editor, AI agent |
| PATCH /notes/{id} | ✅ | `updateNote` (+ `editor_session_id`) | editor autosave, AI agent |
| DELETE /notes/{id} | ✅ | `deleteNote(permanent?)` | move to trash, AI agent |
| POST /notes/{id}/restore | ✅ | `restoreNote` | Trash screen, AI agent |
| PUT /notes/{id}/tags | ✅ | `updateTags` | AI agent (`add_tags`, `tag_notes_by_query`); the editor sends tags through PATCH |
| POST /notes/{id}/favorite | ✅ | `toggleFavorite` | star in the notes list, AI agent |
| POST /notes/{id}/duplicate | ✅ | `duplicateNote` | editor "…" menu, AI agent |
| POST /notes/reorder | ⬜ | — | manual note ordering |
| POST /notes/{id}/folder | ✅ | `moveNoteToFolder` | editor → "…" → "Move to folder…", AI agent |
| POST /notes/{id}/remove-folder | ✅ | `removeNoteFromFolder` | same dialog |
| POST /notes/{id}/archive | ⬜ | — | Archives workspace |
| POST /notes/{id}/beacon | ❌ | — | internal browser API (`sendBeacon` + FormData) |
| GET /graph | ⬜ | — | note-link graph |
| GET /notes/{id}/backlinks | ✅ | `getBacklinks` | editor "…" → "Backlinks…", AI agent |
| PUT /notes/{id}/icon | 🔶 | `updateIcon` | — |
| PUT /notes/{id}/offline | ⬜ | — | server-side offline flag; Pozzy has its own offline cache |
| PUT /notes/{id}/pinned | ⬜ | — | |
| POST /notes/{id}/kanban-completed | ⬜ | — | |
| PUT /notes/{id}/color | 🔶 | `updateColor` | — |
| POST /notes/{id}/convert | ✅ | `convertNote` | editor "…" menu, AI agent |
| GET /notes/{id}/lock | 🔶 | `getLockStatus` | — |
| POST /notes/{id}/lock | ✅ | `acquireLock` | editor (automatic) |
| POST /notes/{id}/lock/heartbeat | ✅ | `heartbeatLock` | editor (automatic, every 45 s) |
| POST /notes/{id}/lock/release | ✅ | `releaseLock` | editor (automatic) |
| GET /offline/manifest, GET /offline/list, GET /offline/notes | ⬜ | — | web offline mode; Pozzy has its own cache and sync queue |
| POST /notes/{id}/snapshot | 🔶 | `createSnapshot` | — |
| GET /notes/{id}/snapshots | ✅ | `listSnapshots` | editor "…" → "Versions" |
| GET /notes/{id}/snapshot | 🔶 | `getSnapshot` | — |
| POST /notes/{id}/snapshot/restore | ✅ | `restoreSnapshot` | "Versions" → restore |

## Reminders — 8 of 10

| Endpoint | Status | Client | Where |
|---|---|---|---|
| GET /notes/{id}/reminder | 🔶 | `getNoteReminder` | — |
| POST /notes/{id}/reminder | ✅ | `setNoteReminder` | editor "…" → "Reminder…" (quick intervals) |
| DELETE /notes/{id}/reminder | ✅ | `deleteNoteReminder` | same dialog |
| POST /notes/{id}/task-reminder, DELETE /notes/{id}/task-reminder | ⬜ | — | per-task reminders in task lists |
| GET /reminders | ✅ | `listNotifications` | Notifications screen |
| GET /reminders/count | ✅ | `getReminderCounts` | bell badge in the notes list, refreshed by `SyncManager` |
| POST /reminders/dismiss-all | ✅ | `dismissAllNotifications` | Notifications screen |
| POST /reminders/{id}/read | ✅ | `markNotificationRead` | Notifications screen |
| POST /reminders/{id}/dismiss | ✅ | `dismissNotification` | Notifications screen |

## Share — 6 of 10

| Endpoint | Status | Client | Where |
|---|---|---|---|
| GET /notes/{id}/share | ✅ | `getShareStatus` | editor "…" → "Public link…" |
| POST /notes/{id}/share | ✅ | `createShare` | create and share the link |
| PATCH /notes/{id}/share | 🔶 | `updateShare` | — |
| DELETE /notes/{id}/share | ✅ | `deleteShare` | "Revoke access" |
| GET /shared | ✅ | `listShared` | Settings → active public links |
| GET /shared/with-me | 🔶 | `listSharedWithMe` | — |
| GET/POST/PATCH/DELETE /folders/{id}/share | ⬜ | — | folder sharing |

## Attachments — 4 of 5

| Endpoint | Status | Client | Where |
|---|---|---|---|
| GET /notes/{noteId}/attachments | ✅ | `listAttachments` | attachments modal in the editor |
| POST /notes/{noteId}/attachments | ✅ | `uploadAttachment` (multipart `fetch`) | attachments modal, share intent, offline upload queue |
| GET /notes/{noteId}/attachments/{attachmentId} | ✅ | `downloadAttachment` (binary `fetch`) | open or share a file |
| DELETE /notes/{noteId}/attachments/{attachmentId} | ✅ | `deleteAttachment` | attachments modal |
| POST /notes/{noteId}/attachments/{attachmentId}/move | ⬜ | — | move an attachment to another note |

## Folders — 16 of 20

| Endpoint | Status | Client | Where |
|---|---|---|---|
| GET /folders | ✅ | `listFolders` | Folders screen, move-to-folder dialog, AI agent |
| POST /folders | ✅ | `createFolder` | "+" on the Folders screen, AI agent |
| GET /folders/counts | ✅ | `getFolderCounts` | counts in the folder list, AI agent |
| GET /folders/suggested | 🔶 | `getSuggestedFolders` | — |
| POST /folders/move-files | 🔶 | `moveFilesBetweenFolders` | — (`target_workspace` since 6.102.0 is not sent) |
| POST /folders/reorder | 🔶 | `reorderFolder` | — |
| POST /folders/kanban-structure | 🔶 | `createKanbanStructure` | — |
| GET /folders/{id} | 🔶 | `getFolder` | — |
| PATCH /folders/{id} | ✅ | `renameFolder` | folder menu, AI agent |
| DELETE /folders/{id} | ✅ | `deleteFolder` | folder menu, AI agent |
| POST /folders/{id}/move | 🔶 | `moveFolder` | — |
| POST /folders/{id}/archive | ⬜ | — | |
| POST /folders/{id}/empty | ✅ | `emptyFolder` | folder menu, AI agent |
| PUT /folders/{id}/icon | 🔶 | `updateFolderIcon` | — |
| PUT /folders/{id}/pinned | ⬜ | — | |
| PUT /folders/{id}/offline | ⬜ | — | |
| PUT /folders/{id}/favorite | ⬜ | — | |
| PUT /folders/{id}/color | 🔶 | `updateFolderColor` | — |
| GET /folders/{id}/notes | ✅ | `getFolderNoteCount` | AI agent (folder tools) |
| GET /folders/{id}/path | 🔶 | `getFolderPath` | — |

Browsing a folder: tap a folder → `NotesList` filtered by `folder_id`.
Moving a note: editor → "…" → "Move to folder…" (`moveNoteToFolder` / `removeNoteFromFolder`).

## Trash — 3 of 3

| Endpoint | Status | Client | Where |
|---|---|---|---|
| GET /trash | ✅ | `listTrash` | Trash screen, AI agent |
| DELETE /trash | ✅ | `emptyTrash` | "Empty" with confirmation; AI agent (`empty_trash`, requires approval) |
| DELETE /trash/{id} | ✅ | `deleteFromTrash` | delete forever |

Restoring from the trash uses `restoreNote` (`POST /notes/{id}/restore`), a button on the Trash screen.

## Workspaces — 4 of 4

| Endpoint | Status | Client | Where |
|---|---|---|---|
| GET /workspaces | ✅ | `listWorkspaces` | switcher in the notes list, AI agent |
| POST /workspaces | ✅ | `createWorkspace` | workspace dialog in the notes list |
| PATCH /workspaces/{name} | ✅ | `renameWorkspace` | same dialog |
| DELETE /workspaces/{name} | ✅ | `deleteWorkspace` | same dialog |

## Tags — 3 of 3, client only

| Endpoint | Status | Client | Where |
|---|---|---|---|
| GET /tags | 🔶 | `listTags` | — |
| PATCH /tags/{tag} | 🔶 | `renameTag` | — |
| DELETE /tags/{tag} | 🔶 | `deleteTag` | — |

## Other groups

| Group | Covered | Status |
|---|---|---|
| Settings | 3 of 3 | 🔶 `getSettings`, `getSetting`, `updateSetting` — no UI |
| System | 3 of 3 | ✅ `getSystemVersion`, `checkUpdates` — Settings; 🔶 `getTranslations` |
| Git Sync | 6 of 6 | ✅ status, test, push, pull, `PUT /git-sync/config` — Settings; 🔶 `getGitSyncProgress` |
| Backups | 6 of 6 | ✅ list, create, delete — Settings; 🔶 download, upload (multipart `fetch`), restore |
| Users | 15 of 27 | ✅ `GET /users/me` — connection setup, `X-User-ID` auto-detection. 🔶 `GET /users/profiles`, `PATCH /users/me`, `POST /users/me/password`, `GET /users/me/password-status`, `GET /users/lookup/{username}`, every `/admin/users*` operation, `/admin/stats`, `/admin/repair`. ⬜ `DELETE /users/me`; app passwords (`/users/me/app-passwords*`, 6.84.0 — Pozzy signs in with an app password but does not manage them); two-factor (`/users/me/two-factor*`, `POST /admin/users/{id}/two-factor/reset`); `/admin/orphan-attachments` |
| Tasks | 0 of 8 | ⬜ `GET /tasks`, `/notes/{id}/tasks*` and subtasks — Pozzy edits task lists as note content |
| Public Tasks | 0 of 3 | ⬜ `POST /public/tasks`, `PATCH/DELETE /public/tasks/{id}` — token-based operations on public task lists, no account needed |
| Export (legacy) | 0 of 7 | ⬜ `api_export_note/folder/entries/structured/attachments.php`, `api_download_note.php` — file downloads, use the web UI if needed. ❌ `api_save_excalidraw.php` — drawing is a separate editor, out of scope for the mobile client |

## Not covered (53 operations)

- **Notes (12):** `GET /notes/search/ids`, `GET /notes/templates`, `POST /notes/reorder`, `POST /notes/{id}/archive`,
  `POST /notes/{id}/beacon` ❌, `GET /graph`, `PUT /notes/{id}/offline`, `PUT /notes/{id}/pinned`,
  `POST /notes/{id}/kanban-completed`, `GET /offline/manifest`, `GET /offline/list`, `GET /offline/notes`
- **Tasks (8):** `GET /tasks`, `GET/POST /notes/{id}/tasks`, `PATCH/DELETE /notes/{id}/tasks/{taskId}`,
  `POST /notes/{id}/tasks/{taskId}/subtasks`, `PATCH/DELETE /notes/{id}/tasks/{taskId}/subtasks/{subtaskId}`
- **Reminders (2):** `POST/DELETE /notes/{id}/task-reminder`
- **Share (4):** `GET/POST/PATCH/DELETE /folders/{id}/share`
- **Attachments (1):** `POST /notes/{noteId}/attachments/{attachmentId}/move`
- **Folders (4):** `POST /folders/{id}/archive`, `PUT /folders/{id}/pinned`, `PUT /folders/{id}/offline`, `PUT /folders/{id}/favorite`
- **Users (12):** `DELETE /users/me`, `GET/POST /users/me/app-passwords`, `DELETE /users/me/app-passwords/{id}`,
  `GET /users/me/two-factor`, `POST /users/me/two-factor/{setup,enable,recovery-codes,disable}`,
  `POST /admin/users/{id}/two-factor/reset`, `GET/DELETE /admin/orphan-attachments`
- **Public Tasks (3):** `POST /public/tasks`, `PATCH/DELETE /public/tasks/{id}`
- **Export (7):** the six `api_export_*.php` / `api_download_note.php` downloads, `POST /api_save_excalidraw.php` ❌

## How this was verified

`docs/openapi.yaml` is byte-identical to the upstream file at the stated version. A script parses
`src/api/client.ts` with the TypeScript compiler API, collects every `this.request('<METHOD>', path)` and
raw `fetch` call, replaces template placeholders with wildcards, strips query strings, and matches each
call against the `paths` of the spec by method and path. Result: 103 of 104 calls match; the single miss
is the removed `create-template` endpoint. Re-run the check whenever the spec is re-synced or a client
call is added.
