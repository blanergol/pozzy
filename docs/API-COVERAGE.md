# Покрытие Poznote API

Источник истины — `docs/openapi.yaml` (копия `src/api-docs/openapi.yaml` из репозитория Poznote).
Отметки: ✅ реализовано · 🔶 реализовано в клиенте, без UI · ❌ намеренно пропущено · ⬜ запланировано.

## Расхождения swagger ↔ реальная реализация сервера

Найдены при сверке с `src/api/v1/controllers/*.php` (клиент написан по реальному поведению):

1. `GET /notes` — в ответе **нет** `entrycontent` (только метаданные); схема `Note` в спеке неточна.
2. `GET /notes/{id}` — содержимое в поле **`content`**, а не `entrycontent`; поля `favorite` и `trash` в ответе нет.
3. Конфликт edit-lock — сервер отвечает **423**, в спеке указан 409 (клиент обрабатывает оба).
4. CORS: `Access-Control-Allow-Headers` не включает `X-User-ID` — браузерные клиенты не могут вызывать data-эндпоинты (баг апстрима, `src/api/v1/index.php:35`).
5. `GET /folders` — режим дерева включается параметром **`hierarchical=true`**, в спеке указан `tree`.
6. `GET /workspaces` — в ответе нет `note_count` (есть в схеме `Workspace` спеки); есть поля `username`, `acting_as`.

## Notes (25/25 методов, beacon пропущен)

| Эндпоинт | Статус | Клиент | UI |
|---|---|---|---|
| GET /notes | ✅ | `listNotes` (все фильтры) | список, поиск |
| POST /notes | ✅ | `createNote` | кнопка «+» |
| GET /notes/{id} | ✅ | `getNote` | редактор |
| PATCH /notes/{id} | ✅ | `updateNote` (+`editor_session_id`) | редактор |
| DELETE /notes/{id} | ✅ | `deleteNote(permanent?)` | удаление в корзину |
| POST /notes/{id}/restore | ✅ | `restoreNote` | экран «Корзина» |
| PUT /notes/{id}/tags | ✅ | `updateTags` | поле тегов (PATCH) |
| POST /notes/{id}/favorite | ✅ | `toggleFavorite` | звезда |
| POST /notes/{id}/duplicate | ✅ | `duplicateNote` | меню «…» |
| POST /notes/{id}/folder | ✅ | `moveNoteToFolder` | редактор → «…» |
| POST /notes/{id}/remove-folder | ✅ | `removeNoteFromFolder` | редактор → «…» |
| POST /notes/{id}/beacon | ❌ | внутренний браузерный API (sendBeacon/FormData) | — |
| GET /notes/{id}/backlinks | ✅ | `getBacklinks` | меню «…» |
| PUT /notes/{id}/icon | 🔶 | `updateIcon` | — |
| PUT /notes/{id}/color | 🔶 | `updateColor` | — |
| POST /notes/{id}/create-template | 🔶 | `createTemplateFromNote` | — |
| POST /notes/{id}/convert | ✅ | `convertNote` | меню «…» |
| GET /notes/{id}/lock | 🔶 | `getLockStatus` | — |
| POST /notes/{id}/lock | ✅ | `acquireLock` | редактор (авто) |
| POST /notes/{id}/lock/heartbeat | ✅ | `heartbeatLock` | редактор (авто, 45с) |
| POST /notes/{id}/lock/release | ✅ | `releaseLock` | редактор (авто) |
| POST /notes/{id}/snapshot | 🔶 | `createSnapshot` | — |
| GET /notes/{id}/snapshots | ✅ | `listSnapshots` | меню «…» → «Версии» |
| GET /notes/{id}/snapshot | 🔶 | `getSnapshot` | — |
| POST /notes/{id}/snapshot/restore | ✅ | `restoreSnapshot` | «Версии» → восстановить |
| GET /notes/{id}/reminder | 🔶 | `getNoteReminder` | — |
| POST /notes/{id}/reminder | ✅ | `setNoteReminder` | меню «…» (быстрые интервалы) |
| DELETE /notes/{id}/reminder | ✅ | `deleteNoteReminder` | там же |
| GET /notes/{id}/share | ✅ | `getShareStatus` | меню «…» |
| POST /notes/{id}/share | ✅ | `createShare` | создание + шеринг ссылки |
| PATCH /notes/{id}/share | 🔶 | `updateShare` | — |
| DELETE /notes/{id}/share | ✅ | `deleteShare` | отзыв доступа |
| GET /notes/resolve | 🔶 | `resolveNote` | — |
| GET /notes/search | 🔶 | `searchNotes` | поиск идёт через `listNotes(search=)` |
| GET /notes/with-attachments | 🔶 | `listNotesWithAttachments` | — |

## Folders (все методы) — ✅ клиент, UI частично

| Эндпоинт | Статус | Клиент | UI |
|---|---|---|---|
| GET /folders | ✅ | `listFolders` | экран «Папки» |
| POST /folders | ✅ | `createFolder` | «+» на экране папок |
| GET /folders/{id} | 🔶 | `getFolder` | — |
| PATCH /folders/{id} | ✅ | `renameFolder` | меню папки |
| DELETE /folders/{id} | ✅ | `deleteFolder` | меню папки |
| GET /folders/counts | ✅ | `getFolderCounts` | счётчики в списке папок |
| GET /folders/suggested | 🔶 | `getSuggestedFolders` | — |
| GET /folders/{id}/path | 🔶 | `getFolderPath` | — |
| GET /folders/{id}/notes | 🔶 | `getFolderNoteCount` | — |
| POST /folders/{id}/move | 🔶 | `moveFolder` | — |
| POST /folders/reorder | 🔶 | `reorderFolder` | — |
| POST /folders/move-files | 🔶 | `moveFilesBetweenFolders` | — |
| POST /folders/kanban-structure | 🔶 | `createKanbanStructure` | — |
| PUT /folders/{id}/icon | 🔶 | `updateFolderIcon` | — |
| PUT /folders/{id}/color | 🔶 | `updateFolderColor` | — |
| POST /folders/{id}/empty | ✅ | `emptyFolder` | меню папки |

Просмотр заметок папки: тап по папке → `NotesList` с фильтром `folder_id`.
Перемещение заметки: редактор → «…» → «Переместить в папку…» (`moveNoteToFolder` / `removeNoteFromFolder`).

## Trash (все методы) — ✅

| Эндпоинт | Статус | Клиент | UI |
|---|---|---|---|
| GET /trash | ✅ | `listTrash` | экран «Корзина» |
| DELETE /trash | ✅ | `emptyTrash` | «Очистить» (с подтверждением) |
| DELETE /trash/{id} | ✅ | `deleteFromTrash` | удаление навсегда |

Восстановление из корзины — `restoreNote` (POST /notes/{id}/restore), кнопка на экране «Корзина».

## Workspaces (все методы) — ✅ клиент, UI частично

| Эндпоинт | Статус | Клиент | UI |
|---|---|---|---|
| GET /workspaces | ✅ | `listWorkspaces` | переключатель в списке заметок |
| POST /workspaces | 🔶 | `createWorkspace` | — |
| PATCH /workspaces/{name} | 🔶 | `renameWorkspace` | — |
| DELETE /workspaces/{name} | 🔶 | `deleteWorkspace` | — |

## Tags (все методы) — ✅ клиент, UI частично

| Эндпоинт | Статус | Клиент | UI |
|---|---|---|---|
| GET /tags | 🔶 | `listTags` | — |
| PATCH /tags/{tag} | 🔶 | `renameTag` | — |
| DELETE /tags/{tag} | 🔶 | `deleteTag` | — |

## Остальные группы

| Группа | Эндпоинты | Статус |
|---|---|---|
| Attachments | GET/POST /notes/{noteId}/attachments, GET/DELETE /notes/{noteId}/attachments/{attachmentId} | ✅ клиент + UI (модалка в редакторе: список, загрузка, открытие, удаление) |
| Reminders (глоб.) | GET /reminders, GET /reminders/count, POST /reminders/dismiss-all, POST /reminders/{id}/read, POST /reminders/{id}/dismiss | ✅ клиент + UI (экран «Уведомления» + бейдж на колокольчике) |
| Shared | GET /shared, GET /shared/with-me | ✅ клиент; /shared — UI на экране «Ещё»; with-me 🔶 без UI |
| Settings | GET /settings, GET/PUT /settings/{key} | ✅ клиент (`getSettings`, `getSetting`, `updateSetting`), 🔶 без UI |
| System | GET /system/version, updates, i18n | ✅ клиент; version/updates — UI «Ещё»; i18n 🔶 без UI |
| Git sync | status, test, push, pull, progress, PUT /git-sync/config | ✅ клиент; status/test/push/pull/config — UI «Ещё»; progress 🔶 без UI |
| Backups | GET/POST /backups, GET/DELETE /backups/{filename}, POST restore, POST upload | ✅ клиент; список/создание/удаление — UI «Ещё»; download/upload/restore 🔶 без UI |
| Users | GET /users/profiles, GET/PATCH /users/me, POST /users/me/password, password-status, lookup | ✅ клиент; GET /users/me — UI подключения; остальное 🔶 без UI |
| Admin | GET/POST /admin/users, GET/PATCH/DELETE /admin/users/{id}, reset-password, password-status, /admin/stats, /admin/repair | ✅ клиент, 🔶 без UI |
| Folder sharing | GET/POST/PATCH/DELETE /folders/{folderId}/share | ⬜ |
| Public tasks | POST /public/tasks, PATCH/DELETE /public/tasks/{id} | ⬜ (операции с публичными tasklist по токену — без аккаунта) |
| Export (legacy) | api_export_note/folder/entries/structured/attachments, api_download_note | ⬜ (скачивание файлов; при необходимости — через веб) |
| Excalidraw | POST /api_save_excalidraw.php | ❌ (рисование — отдельный редактор, вне мобильной итерации) |

Сводка: 100 вызовов в `src/api/client.ts`, все сверены с `docs/openapi.yaml` (скрипт-проверка: 100/100 совпадений по пути и методу).
