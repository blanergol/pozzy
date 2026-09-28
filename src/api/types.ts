// Типы отражают РЕАЛЬНЫЕ ответы сервера (src/api/v1/controllers/*.php),
// которые местами расходятся с docs/openapi.yaml — расхождения отмечены в docs/API-COVERAGE.md.

/** Элемент списка заметок: GET /notes (содержимого в списке нет). */
export interface NoteListItem {
  id: number;
  heading: string;
  type: string;
  tags: string | null;
  folder: string | null;
  folder_id: number | null;
  workspace: string | null;
  updated: string;
  created: string;
  favorite: number;
  icon: string | null;
  icon_color: string | null;
  color: string | null;
  color_hex: string | null;
}

/** Полная заметка: GET /notes/{id} (поле content, а не entrycontent; favorite отсутствует). */
export interface NoteDetails {
  id: number;
  heading: string;
  workspace: string | null;
  type: string;
  tags: string | null;
  folder: string | null;
  folder_id: number | null;
  linked_note_id: number | null;
  icon: string | null;
  icon_color: string | null;
  color: string | null;
  color_hex: string | null;
  created: string | null;
  updated: string | null;
  reminder_at: string | null;
  content: string;
}

export interface CurrentUser {
  id: number;
  username: string;
  display_name?: string;
  is_admin?: boolean;
}

export interface ListNotesParams {
  workspace?: string;
  folder?: string;
  folder_id?: number;
  search?: string;
  favorite?: boolean;
  created_from?: string;
  created_to?: string;
  sort?: 'updated_desc' | 'created_desc' | 'heading_asc';
}

export interface SearchNotesParams {
  q: string;
  workspace?: string;
  limit?: number;
  created_from?: string;
  created_to?: string;
}

export interface CreateNotePayload {
  heading: string;
  content?: string;
  tags?: string;
  workspace?: string;
  folder?: string;
  folder_id?: number | null;
  type?: 'note' | 'markdown' | 'tasklist';
}

export interface UpdateNotePayload {
  heading?: string;
  content?: string;
  tags?: string;
  folder_id?: number | null;
  workspace?: string;
  git_push?: boolean;
}

export interface Backlink {
  id: number;
  heading: string;
  workspace?: string | null;
}

export interface BacklinksResponse {
  success: boolean;
  backlinks: Backlink[];
  count: number;
}

export interface NoteEditLock {
  target_user_id: number;
  note_id: number;
  holder_login_user_id: number;
  holder_username: string;
  holder_is_current_user: boolean;
  holder_is_current_editor_session: boolean;
  expires_at: string;
  last_seen_at: string;
}

export interface LockStatusResponse {
  success: boolean;
  locked?: boolean;
  lock?: NoteEditLock | null;
}

export interface SnapshotInfo {
  snapshot_key: string;
  date: string;
  heading: string;
  type: string;
  manual: boolean;
  created_at: string;
}

export interface SnapshotsListResponse {
  success: boolean;
  empty_new_note: boolean;
  snapshots: SnapshotInfo[];
}

export interface SnapshotContentResponse {
  success: boolean;
  content?: string;
  heading?: string;
  [key: string]: unknown;
}

export interface SetReminderPayload {
  reminder_at: string;
  message?: string;
  email_enabled?: boolean;
  recurrence?: string;
}

export interface NoteReminder {
  note_id?: number;
  reminder_at: string | null;
  recurrence?: string | null;
  [key: string]: unknown;
}

export interface ShareStatus {
  success: boolean;
  public: boolean;
  url?: string;
  url_query?: string;
  url_workspace?: string;
  indexable?: number;
  hasPassword?: boolean;
  noteType?: string;
  accessMode?: string;
  workspace?: string;
}

export interface CreateSharePayload {
  theme?: 'light' | 'dark' | 'black';
  indexable?: boolean;
  password?: string;
  custom_token?: string;
  access_mode?: 'read_only' | 'check_only' | 'full';
}

export interface UpdateSharePayload {
  indexable?: boolean;
  password?: string;
  custom_token?: string;
  access_mode?: 'read_only' | 'check_only' | 'full';
  allowed_users?: number[];
}

// ===== Folders =====

/** GET /folders (flat) — поле path содержит полный путь вида "Родитель/Дочерняя". */
export interface Folder {
  id: number;
  name: string;
  parent_id: number | null;
  icon: string | null;
  icon_color: string | null;
  color: string | null;
  color_hex: string | null;
  display_order: number;
  path?: string;
  created?: string | null;
}

/** GET /folders/counts: ключи — id папок, плюс 'uncategorized' и 'Favorites'. */
export type FolderCounts = Record<string, number>;

export interface CreateFolderPayload {
  name: string;
  workspace?: string;
  parent_id?: number | null;
}

// ===== Trash =====

/** Элемент корзины: GET /trash. */
export interface TrashedNote {
  id: number;
  heading: string;
  tags: string | null;
  folder: string | null;
  folder_id: number | null;
  workspace: string | null;
  type: string;
  updated: string;
  created: string;
}

// ===== Workspaces =====

export interface Workspace {
  name: string;
  created?: string | null;
}

// ===== Tags =====
// GET /tags возвращает { success, tags: string[] }

// ===== Attachments =====

export interface Attachment {
  id: string;
  filename: string;
  original_filename: string;
  file_size: number;
  file_type: string;
  uploaded_at: string;
}

/** Файл из expo-document-picker для загрузки. */
export interface UploadFile {
  uri: string;
  name: string;
  mimeType?: string;
}

// ===== Notifications (глобальные reminders) =====

export interface NotificationItem {
  id: number;
  note_id: number;
  type: string;
  message: string;
  trigger_at: string;
  is_read: number;
  heading?: string | null;
  workspace?: string | null;
}

export interface ReminderCounts {
  unread_count: number;
  total_count: number;
}

// ===== Shared =====

export interface SharedItem {
  id?: number;
  note_id?: number;
  heading?: string;
  type?: string;
  token?: string;
  url?: string;
  kind?: string;
  [key: string]: unknown;
}

// ===== System =====

export interface SystemInfo {
  current_version?: string;
  latest_version?: string;
  is_up_to_date?: boolean;
  has_update?: boolean;
  [key: string]: unknown;
}

export interface UpdateInfo {
  update_available?: boolean;
  has_update?: boolean;
  latest_version?: string;
  current_version?: string;
  [key: string]: unknown;
}

// ===== Backups =====

export interface BackupFile {
  filename: string;
  size?: number;
  size_mb?: number;
  created?: string;
  [key: string]: unknown;
}

// ===== Git sync =====

export interface GitSyncConfigStatus {
  enabled?: boolean;
  configured?: boolean;
  repo?: string | null;
  branch?: string;
  hasToken?: boolean;
  provider?: string;
  apiBase?: string;
  authorName?: string;
  authorEmail?: string;
  autoPush?: boolean;
  autoPull?: boolean;
}

/** GET /git-sync/status: { success, enabled, config: {...}, lastSync } */
export interface GitSyncStatus {
  success?: boolean;
  enabled?: boolean;
  message?: string;
  config?: GitSyncConfigStatus;
  lastSync?: unknown;
  [key: string]: unknown;
}

/** POST /git-sync/test: { success, error? } */
export interface GitSyncTestResult {
  success: boolean;
  error?: string;
  message?: string;
}

export interface GitSyncProgress {
  status?: string;
  progress?: number;
  message?: string;
  [key: string]: unknown;
}

/** PUT /git-sync/config: поля сохраняются по одному — отсутствующие ключи сервер не трогает,
 *  пустая строка очищает значение. Пустой token при редактировании не отправляем, чтобы
 *  не затирать сохранённый. */
export interface GitSyncConfig {
  provider?: 'github' | 'gitlab' | 'forgejo';
  repo?: string;
  token?: string;
  branch?: string;
  api_base?: string;
  author_name?: string;
  author_email?: string;
  workspaces?: string[] | null;
  [key: string]: unknown;
}

// ===== Users / Admin =====

export interface UserProfile {
  id: number;
  username: string;
  display_name?: string;
  is_admin?: boolean;
  disabled?: boolean;
  [key: string]: unknown;
}

export interface AdminStats {
  [key: string]: unknown;
}
