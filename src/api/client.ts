import { base64Encode } from '../utils/base64';
import { translate } from '../i18n';
import {
  Attachment,
  Backlink,
  BacklinksResponse,
  BackupFile,
  CreateFolderPayload,
  CreateNotePayload,
  CreateSharePayload,
  CurrentUser,
  Folder,
  FolderCounts,
  GitSyncConfig,
  GitSyncProgress,
  GitSyncStatus,
  GitSyncTestResult,
  ListNotesParams,
  LockStatusResponse,
  NoteDetails,
  NoteListItem,
  NoteReminder,
  NotificationItem,
  ReminderCounts,
  SearchNotesParams,
  SetReminderPayload,
  ShareStatus,
  SharedItem,
  SnapshotContentResponse,
  SnapshotInfo,
  SnapshotsListResponse,
  SystemInfo,
  TrashedNote,
  UpdateInfo,
  UpdateNotePayload,
  UpdateSharePayload,
  UploadFile,
  UserProfile,
  AdminStats,
  Workspace,
} from './types';

export interface ServerSettings {
  baseUrl: string;
  username: string;
  password: string;
  userId: string;
}

/** Приводит адрес сервера к виду https://host[:port] без завершающего слэша. */
export function normalizeBaseUrl(url: string): string {
  let u = url.trim();
  if (!u) return u;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/+$/, '');
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Заметка заблокирована другой сессией редактирования (423/409 + данные лока). */
export class LockConflictError extends ApiError {
  lock: unknown;

  constructor(status: number, message: string, lock: unknown) {
    super(status, message);
    this.lock = lock;
  }
}

/** Человекочитаемое описание ошибки запроса. */
export function describeError(error: unknown): string {
  if (error instanceof LockConflictError) {
    return translate('error.lock');
  }
  if (error instanceof ApiError) {
    if (error.status === 401) return translate('error.auth');
    if (error.status === 403) return translate('error.forbidden');
    if (error.status === 404) return translate('error.notFound');
    return translate('error.server', { status: error.status, message: error.message });
  }
  return translate('error.network');
}

export class PoznoteClient {
  constructor(private readonly settings: ServerSettings) {}

  private get authHeader(): string {
    return 'Basic ' + base64Encode(`${this.settings.username}:${this.settings.password}`);
  }

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; withUserId?: boolean; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const { body, withUserId = true, headers: extraHeaders } = options;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: this.authHeader,
      ...extraHeaders,
    };
    if (withUserId && this.settings.userId.trim()) {
      headers['X-User-ID'] = this.settings.userId.trim();
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let res: Response;
    try {
      res = await fetch(`${this.settings.baseUrl}/api/v1${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error('network');
    }

    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // не-JSON ответ (например HTML от прокси) — обработаем ниже по статусу
    }

    if (!res.ok) {
      const message = json?.error ?? json?.message ?? `HTTP ${res.status}`;
      // Сервер отвечает 423 (по коду) / 409 (по спеке) при чужом edit-lock'е
      if (res.status === 423 || res.status === 409) {
        throw new LockConflictError(res.status, message, json?.lock ?? null);
      }
      throw new ApiError(res.status, message);
    }
    return json as T;
  }

  // ===== Users =====

  /** Текущий пользователь по учётным данным (X-User-ID не требуется). */
  async getMe(): Promise<CurrentUser> {
    return this.request<CurrentUser>('GET', '/users/me', { withUserId: false });
  }

  // ===== Notes =====

  async listNotes(params: ListNotesParams = {}): Promise<NoteListItem[]> {
    const query = new URLSearchParams();
    if (params.workspace) query.set('workspace', params.workspace);
    if (params.folder) query.set('folder', params.folder);
    if (params.folder_id !== undefined) query.set('folder_id', String(params.folder_id));
    if (params.search) query.set('search', params.search);
    if (params.favorite) query.set('favorite', '1');
    if (params.created_from) query.set('created_from', params.created_from);
    if (params.created_to) query.set('created_to', params.created_to);
    query.set('sort', params.sort ?? 'updated_desc');
    const res = await this.request<{ success: boolean; notes: NoteListItem[] }>(
      'GET',
      `/notes?${query.toString()}`,
    );
    // SQLite через PDO может вернуть favorite строкой — нормализуем в number
    return (res.notes ?? []).map((n) => ({ ...n, favorite: Number(n.favorite ?? 0) }));
  }

  /** Поиск с excerpt'ами: GET /notes/search */
  async searchNotes(params: SearchNotesParams): Promise<NoteListItem[]> {
    const query = new URLSearchParams({ q: params.q });
    if (params.workspace) query.set('workspace', params.workspace);
    if (params.limit) query.set('limit', String(params.limit));
    if (params.created_from) query.set('created_from', params.created_from);
    if (params.created_to) query.set('created_to', params.created_to);
    const res = await this.request<{ success: boolean; notes?: NoteListItem[]; results?: NoteListItem[] }>(
      'GET',
      `/notes/search?${query.toString()}`,
    );
    return res.notes ?? res.results ?? [];
  }

  /** Заметки с вложениями: GET /notes/with-attachments */
  async listNotesWithAttachments(): Promise<NoteListItem[]> {
    const res = await this.request<{ success: boolean; notes?: NoteListItem[] }>(
      'GET',
      '/notes/with-attachments',
    );
    return res.notes ?? [];
  }

  /** Разрешить заметку по заголовку в workspace: GET /notes/resolve */
  async resolveNote(reference: string, workspace: string): Promise<NoteDetails> {
    const query = new URLSearchParams({ reference, workspace });
    const res = await this.request<{ success: boolean; note: NoteDetails }>(
      'GET',
      `/notes/resolve?${query.toString()}`,
    );
    return res.note;
  }

  async getNote(id: number, workspace?: string): Promise<NoteDetails> {
    const qs = workspace ? `?${new URLSearchParams({ workspace }).toString()}` : '';
    const res = await this.request<{ success: boolean; note: NoteDetails }>(
      'GET',
      `/notes/${id}${qs}`,
    );
    return res.note;
  }

  async createNote(payload: CreateNotePayload): Promise<number> {
    // Сервер возвращает { success, note: { id, ... } } (в спеке указан плоский id — неточно)
    const res = await this.request<{
      success: boolean;
      id?: number;
      note_id?: number;
      note?: { id?: number };
    }>('POST', '/notes', { body: payload });
    const id = res.note?.id ?? res.id ?? res.note_id;
    if (!id) throw new ApiError(500, translate('error.noNoteId'));
    return id;
  }

  async updateNote(
    id: number,
    payload: UpdateNotePayload,
    editorSessionId?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = { ...payload };
    if (editorSessionId) body.editor_session_id = editorSessionId;
    await this.request('PATCH', `/notes/${id}`, { body });
  }

  /** Удаление: в корзину (по умолчанию) или навсегда (permanent=true). */
  async deleteNote(id: number, permanent = false): Promise<void> {
    await this.request('DELETE', `/notes/${id}${permanent ? '?permanent=true' : ''}`);
  }

  async restoreNote(id: number): Promise<void> {
    await this.request('POST', `/notes/${id}/restore`);
  }

  async duplicateNote(id: number): Promise<number | null> {
    const res = await this.request<{ success: boolean; id?: number; new_id?: number }>(
      'POST',
      `/notes/${id}/duplicate`,
    );
    return res.id ?? res.new_id ?? null;
  }

  async toggleFavorite(id: number): Promise<void> {
    await this.request('POST', `/notes/${id}/favorite`);
  }

  async updateTags(id: number, tags: string): Promise<void> {
    await this.request('PUT', `/notes/${id}/tags`, { body: { tags } });
  }

  async updateIcon(id: number, icon: string, iconColor = ''): Promise<void> {
    await this.request('PUT', `/notes/${id}/icon`, {
      body: { icon, icon_color: iconColor },
    });
  }

  async updateColor(id: number, color: string): Promise<void> {
    await this.request('PUT', `/notes/${id}/color`, { body: { color } });
  }

  async moveNoteToFolder(id: number, folderId: number): Promise<void> {
    await this.request('POST', `/notes/${id}/folder`, { body: { folder_id: folderId } });
  }

  async removeNoteFromFolder(id: number): Promise<void> {
    await this.request('POST', `/notes/${id}/remove-folder`);
  }

  async convertNote(id: number, target: 'html' | 'markdown'): Promise<void> {
    await this.request('POST', `/notes/${id}/convert`, { body: { target } });
  }

  async createTemplateFromNote(id: number): Promise<void> {
    await this.request('POST', `/notes/${id}/create-template`);
  }

  async getBacklinks(id: number): Promise<Backlink[]> {
    const res = await this.request<BacklinksResponse>('GET', `/notes/${id}/backlinks`);
    return res.backlinks ?? [];
  }

  // ===== Note locks =====

  async acquireLock(id: number, editorSessionId: string): Promise<void> {
    await this.request('POST', `/notes/${id}/lock`, {
      body: { editor_session_id: editorSessionId },
    });
  }

  async getLockStatus(id: number): Promise<LockStatusResponse> {
    return this.request<LockStatusResponse>('GET', `/notes/${id}/lock`);
  }

  async heartbeatLock(id: number, editorSessionId: string): Promise<void> {
    await this.request('POST', `/notes/${id}/lock/heartbeat`, {
      body: { editor_session_id: editorSessionId },
    });
  }

  async releaseLock(id: number, editorSessionId: string): Promise<void> {
    await this.request('POST', `/notes/${id}/lock/release`, {
      body: { editor_session_id: editorSessionId },
    });
  }

  // ===== Snapshots =====

  async createSnapshot(id: number, manual = false): Promise<void> {
    await this.request('POST', `/notes/${id}/snapshot${manual ? '?manual=1' : ''}`);
  }

  async listSnapshots(id: number): Promise<SnapshotInfo[]> {
    const res = await this.request<SnapshotsListResponse>('GET', `/notes/${id}/snapshots`);
    return res.snapshots ?? [];
  }

  async getSnapshot(id: number, keyOrDate: { snapshotKey?: string; date?: string }): Promise<SnapshotContentResponse> {
    const query = new URLSearchParams();
    if (keyOrDate.snapshotKey) query.set('snapshot_key', keyOrDate.snapshotKey);
    if (keyOrDate.date) query.set('date', keyOrDate.date);
    return this.request<SnapshotContentResponse>('GET', `/notes/${id}/snapshot?${query.toString()}`);
  }

  async restoreSnapshot(id: number, keyOrDate: { snapshotKey?: string; date?: string }): Promise<void> {
    const query = new URLSearchParams();
    if (keyOrDate.snapshotKey) query.set('snapshot_key', keyOrDate.snapshotKey);
    if (keyOrDate.date) query.set('date', keyOrDate.date);
    await this.request('POST', `/notes/${id}/snapshot/restore?${query.toString()}`);
  }

  // ===== Note reminder =====

  async getNoteReminder(id: number): Promise<NoteReminder | null> {
    const res = await this.request<{ success: boolean } & NoteReminder>('GET', `/notes/${id}/reminder`);
    return res.reminder_at ? res : null;
  }

  async setNoteReminder(id: number, payload: SetReminderPayload): Promise<void> {
    await this.request('POST', `/notes/${id}/reminder`, { body: payload });
  }

  async deleteNoteReminder(id: number): Promise<void> {
    await this.request('DELETE', `/notes/${id}/reminder`);
  }

  // ===== Note sharing =====

  async getShareStatus(id: number): Promise<ShareStatus> {
    return this.request<ShareStatus>('GET', `/notes/${id}/share`);
  }

  async createShare(id: number, payload: CreateSharePayload = {}): Promise<ShareStatus> {
    return this.request<ShareStatus>('POST', `/notes/${id}/share`, { body: payload });
  }

  async updateShare(id: number, payload: UpdateSharePayload): Promise<void> {
    await this.request('PATCH', `/notes/${id}/share`, { body: payload });
  }

  async deleteShare(id: number): Promise<void> {
    await this.request('DELETE', `/notes/${id}/share`);
  }

  // ===== Folders =====

  async listFolders(workspace?: string): Promise<Folder[]> {
    const query = new URLSearchParams();
    if (workspace) query.set('workspace', workspace);
    const qs = query.toString();
    const res = await this.request<{ success: boolean; folders: Folder[] }>(
      'GET',
      `/folders${qs ? `?${qs}` : ''}`,
    );
    return res.folders ?? [];
  }

  async getFolder(id: number): Promise<Folder> {
    const res = await this.request<{ success: boolean; folder: Folder }>('GET', `/folders/${id}`);
    return res.folder;
  }

  /** Счётчики заметок: { [folderId]: n, uncategorized: n, Favorites: n }. */
  async getFolderCounts(workspace?: string): Promise<FolderCounts> {
    const query = new URLSearchParams();
    if (workspace) query.set('workspace', workspace);
    const qs = query.toString();
    const res = await this.request<{ success: boolean; counts: FolderCounts }>(
      'GET',
      `/folders/counts${qs ? `?${qs}` : ''}`,
    );
    return res.counts ?? {};
  }

  async getSuggestedFolders(): Promise<Folder[]> {
    const res = await this.request<{ success: boolean; folders?: Folder[]; suggested?: Folder[] }>(
      'GET',
      '/folders/suggested',
    );
    return res.folders ?? res.suggested ?? [];
  }

  async getFolderPath(id: number): Promise<string> {
    const res = await this.request<{ success: boolean; path?: string }>('GET', `/folders/${id}/path`);
    return res.path ?? '';
  }

  async getFolderNoteCount(id: number): Promise<number> {
    const res = await this.request<{ success: boolean; count?: number }>('GET', `/folders/${id}/notes`);
    return res.count ?? 0;
  }

  async createFolder(payload: CreateFolderPayload): Promise<number | null> {
    const res = await this.request<{ success: boolean; id?: number }>('POST', '/folders', {
      body: payload,
    });
    return res.id ?? null;
  }

  async renameFolder(id: number, name: string): Promise<void> {
    await this.request('PATCH', `/folders/${id}`, { body: { name } });
  }

  async deleteFolder(id: number): Promise<void> {
    await this.request('DELETE', `/folders/${id}`);
  }

  async moveFolder(id: number, parentId: number | null, targetWorkspace?: string): Promise<void> {
    const body: Record<string, unknown> = { parent_id: parentId };
    if (targetWorkspace) body.target_workspace = targetWorkspace;
    await this.request('POST', `/folders/${id}/move`, { body });
  }

  async reorderFolder(
    folderId: number,
    targetFolderId: number,
    position: 'before' | 'after',
    workspace?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      folder_id: folderId,
      target_folder_id: targetFolderId,
      position,
    };
    if (workspace) body.workspace = workspace;
    await this.request('POST', '/folders/reorder', { body });
  }

  async moveFilesBetweenFolders(sourceFolderId: number, targetFolderId: number): Promise<void> {
    await this.request('POST', '/folders/move-files', {
      body: { source_folder_id: sourceFolderId, target_folder_id: targetFolderId },
    });
  }

  async createKanbanStructure(
    folderName: string,
    columns: number,
    workspace?: string,
    parentFolderId?: number,
  ): Promise<void> {
    const body: Record<string, unknown> = { folder_name: folderName, columns };
    if (workspace) body.workspace = workspace;
    if (parentFolderId !== undefined) body.parent_folder_id = parentFolderId;
    await this.request('POST', '/folders/kanban-structure', { body });
  }

  async updateFolderIcon(id: number, icon: string): Promise<void> {
    await this.request('PUT', `/folders/${id}/icon`, { body: { icon } });
  }

  async updateFolderColor(id: number, color: string): Promise<void> {
    await this.request('PUT', `/folders/${id}/color`, { body: { color } });
  }

  /** Переместить все заметки папки в корзину. */
  async emptyFolder(id: number): Promise<void> {
    await this.request('POST', `/folders/${id}/empty`);
  }

  // ===== Trash =====

  async listTrash(workspace?: string, search?: string): Promise<TrashedNote[]> {
    const query = new URLSearchParams();
    if (workspace) query.set('workspace', workspace);
    if (search) query.set('search', search);
    const qs = query.toString();
    const res = await this.request<{ success: boolean; notes: TrashedNote[] }>(
      'GET',
      `/trash${qs ? `?${qs}` : ''}`,
    );
    return res.notes ?? [];
  }

  /** Очистить корзину (необратимо). */
  async emptyTrash(workspace?: string): Promise<void> {
    const qs = workspace ? `?${new URLSearchParams({ workspace }).toString()}` : '';
    await this.request('DELETE', `/trash${qs}`);
  }

  /** Удалить заметку из корзины навсегда. */
  async deleteFromTrash(id: number): Promise<void> {
    await this.request('DELETE', `/trash/${id}`);
  }

  // ===== Workspaces =====

  async listWorkspaces(): Promise<Workspace[]> {
    const res = await this.request<{ success: boolean; workspaces: Workspace[] }>(
      'GET',
      '/workspaces',
    );
    return res.workspaces ?? [];
  }

  async createWorkspace(name: string): Promise<void> {
    await this.request('POST', '/workspaces', { body: { name } });
  }

  async renameWorkspace(name: string, newName: string): Promise<void> {
    await this.request('PATCH', `/workspaces/${encodeURIComponent(name)}`, {
      body: { new_name: newName },
    });
  }

  async deleteWorkspace(name: string): Promise<void> {
    await this.request('DELETE', `/workspaces/${encodeURIComponent(name)}`);
  }

  // ===== Tags =====

  async listTags(workspace?: string): Promise<string[]> {
    const query = new URLSearchParams();
    if (workspace) query.set('workspace', workspace);
    const qs = query.toString();
    const res = await this.request<{ success: boolean; tags: string[] }>(
      'GET',
      `/tags${qs ? `?${qs}` : ''}`,
    );
    return res.tags ?? [];
  }

  async renameTag(tag: string, newName: string, workspace?: string): Promise<void> {
    const body: Record<string, unknown> = { new_name: newName };
    if (workspace) body.workspace = workspace;
    await this.request('PATCH', `/tags/${encodeURIComponent(tag)}`, { body });
  }

  async deleteTag(tag: string, workspace?: string): Promise<void> {
    const qs = workspace ? `?${new URLSearchParams({ workspace }).toString()}` : '';
    await this.request('DELETE', `/tags/${encodeURIComponent(tag)}${qs}`);
  }

  // ===== Attachments =====

  async listAttachments(noteId: number, workspace?: string): Promise<Attachment[]> {
    const qs = workspace ? `?${new URLSearchParams({ workspace }).toString()}` : '';
    const res = await this.request<{ success: boolean; attachments: Attachment[] }>(
      'GET',
      `/notes/${noteId}/attachments${qs}`,
    );
    return res.attachments ?? [];
  }

  /** Загрузка файла (multipart/form-data). Работает на нативных платформах (RN FormData). */
  async uploadAttachment(
    noteId: number,
    file: UploadFile,
    workspace?: string,
  ): Promise<{ attachmentId: string; filename: string }> {
    const formData = new FormData();
    // React Native умеет отправлять {uri, name, type} как файл
    formData.append('file', {
      uri: file.uri,
      name: file.name,
      type: file.mimeType ?? 'application/octet-stream',
    } as unknown as Blob);
    if (workspace) formData.append('workspace', workspace);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: this.authHeader,
    };
    if (this.settings.userId.trim()) {
      headers['X-User-ID'] = this.settings.userId.trim();
    }

    let res: Response;
    try {
      res = await fetch(`${this.settings.baseUrl}/api/v1/notes/${noteId}/attachments`, {
        method: 'POST',
        headers,
        body: formData,
      });
    } catch {
      throw new Error('network');
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const message = json?.error ?? json?.message ?? `HTTP ${res.status}`;
      throw new ApiError(res.status, message);
    }
    return { attachmentId: json?.attachment_id ?? '', filename: json?.filename ?? file.name };
  }

  /** Скачивание вложения в bytes (для сохранения через expo-file-system). */
  async downloadAttachment(
    noteId: number,
    attachmentId: string,
    workspace?: string,
  ): Promise<{ data: ArrayBuffer; contentType: string | null }> {
    const query = new URLSearchParams();
    if (workspace) query.set('workspace', workspace);
    const qs = query.toString();
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
    };
    if (this.settings.userId.trim()) {
      headers['X-User-ID'] = this.settings.userId.trim();
    }
    let res: Response;
    try {
      res = await fetch(
        `${this.settings.baseUrl}/api/v1/notes/${noteId}/attachments/${attachmentId}${qs ? `?${qs}` : ''}`,
        { headers },
      );
    } catch {
      throw new Error('network');
    }
    if (!res.ok) {
      throw new ApiError(res.status, `HTTP ${res.status}`);
    }
    return { data: await res.arrayBuffer(), contentType: res.headers.get('Content-Type') };
  }

  async deleteAttachment(noteId: number, attachmentId: string): Promise<void> {
    await this.request('DELETE', `/notes/${noteId}/attachments/${attachmentId}`);
  }

  // ===== Notifications (глобальные reminders) =====

  async listNotifications(workspace?: string): Promise<NotificationItem[]> {
    const query = new URLSearchParams();
    if (workspace) query.set('workspace', workspace);
    const qs = query.toString();
    const res = await this.request<{ success: boolean; notifications: NotificationItem[] }>(
      'GET',
      `/reminders${qs ? `?${qs}` : ''}`,
    );
    return res.notifications ?? [];
  }

  async getReminderCounts(workspace?: string): Promise<ReminderCounts> {
    const query = new URLSearchParams();
    if (workspace) query.set('workspace', workspace);
    const qs = query.toString();
    const res = await this.request<{ success: boolean } & ReminderCounts>(
      'GET',
      `/reminders/count${qs ? `?${qs}` : ''}`,
    );
    return { unread_count: res.unread_count ?? 0, total_count: res.total_count ?? 0 };
  }

  async markNotificationRead(id: number): Promise<void> {
    await this.request('POST', `/reminders/${id}/read`);
  }

  async dismissNotification(id: number): Promise<void> {
    await this.request('POST', `/reminders/${id}/dismiss`);
  }

  async dismissAllNotifications(): Promise<void> {
    await this.request('POST', '/reminders/dismiss-all');
  }

  // ===== Shared =====

  async listShared(workspace?: string): Promise<SharedItem[]> {
    const query = new URLSearchParams();
    if (workspace) query.set('workspace', workspace);
    const qs = query.toString();
    const res = await this.request<{ success: boolean; shared?: SharedItem[]; notes?: SharedItem[] }>(
      'GET',
      `/shared${qs ? `?${qs}` : ''}`,
      { withUserId: false },
    );
    return res.shared ?? res.notes ?? [];
  }

  async listSharedWithMe(): Promise<SharedItem[]> {
    const res = await this.request<{ success: boolean; shared?: SharedItem[]; items?: SharedItem[] }>(
      'GET',
      '/shared/with-me',
      { withUserId: false },
    );
    return res.shared ?? res.items ?? [];
  }

  // ===== Settings =====

  async getSettings(keys?: string[]): Promise<Record<string, unknown>> {
    const qs = keys?.length ? `?${new URLSearchParams({ keys: keys.join(',') }).toString()}` : '';
    const res = await this.request<{ success: boolean; settings: Record<string, unknown> }>(
      'GET',
      `/settings${qs}`,
    );
    return res.settings ?? {};
  }

  async getSetting(key: string): Promise<unknown> {
    const res = await this.request<{ success: boolean; value: unknown }>(
      'GET',
      `/settings/${encodeURIComponent(key)}`,
    );
    return res.value;
  }

  async updateSetting(key: string, value: unknown): Promise<void> {
    await this.request('PUT', `/settings/${encodeURIComponent(key)}`, { body: { value } });
  }

  // ===== System =====

  async getSystemVersion(): Promise<SystemInfo> {
    return this.request<SystemInfo>('GET', '/system/version', { withUserId: false });
  }

  async checkUpdates(): Promise<UpdateInfo> {
    return this.request<UpdateInfo>('GET', '/system/updates', { withUserId: false });
  }

  async getTranslations(lang: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      'GET',
      `/system/i18n?${new URLSearchParams({ lang }).toString()}`,
      { withUserId: false },
    );
  }

  // ===== Git sync =====

  async getGitSyncStatus(): Promise<GitSyncStatus> {
    return this.request<GitSyncStatus>('GET', '/git-sync/status');
  }

  async testGitSync(): Promise<GitSyncTestResult> {
    return this.request<GitSyncTestResult>('POST', '/git-sync/test');
  }

  async pushGitSync(asyncMode = false): Promise<void> {
    await this.request('POST', '/git-sync/push', { body: { async: asyncMode } });
  }

  async pullGitSync(asyncMode = false): Promise<void> {
    await this.request('POST', '/git-sync/pull', { body: { async: asyncMode } });
  }

  async getGitSyncProgress(): Promise<GitSyncProgress> {
    return this.request<GitSyncProgress>('GET', '/git-sync/progress');
  }

  async updateGitSyncConfig(config: GitSyncConfig): Promise<void> {
    await this.request('PUT', '/git-sync/config', { body: config });
  }

  // ===== Backups =====

  async listBackups(): Promise<BackupFile[]> {
    const res = await this.request<{ success: boolean; backups: BackupFile[] }>('GET', '/backups');
    return res.backups ?? [];
  }

  async createBackup(): Promise<{ filename?: string }> {
    const res = await this.request<{ success: boolean; filename?: string }>('POST', '/backups');
    return { filename: res.filename };
  }

  async downloadBackup(filename: string): Promise<ArrayBuffer> {
    const headers: Record<string, string> = { Authorization: this.authHeader };
    if (this.settings.userId.trim()) headers['X-User-ID'] = this.settings.userId.trim();
    let res: Response;
    try {
      res = await fetch(
        `${this.settings.baseUrl}/api/v1/backups/${encodeURIComponent(filename)}`,
        { headers },
      );
    } catch {
      throw new Error('network');
    }
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
    return res.arrayBuffer();
  }

  async uploadBackup(file: UploadFile): Promise<{ filename: string }> {
    const formData = new FormData();
    formData.append('file', {
      uri: file.uri,
      name: file.name,
      type: file.mimeType ?? 'application/zip',
    } as unknown as Blob);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: this.authHeader,
    };
    if (this.settings.userId.trim()) headers['X-User-ID'] = this.settings.userId.trim();
    let res: Response;
    try {
      res = await fetch(`${this.settings.baseUrl}/api/v1/backups/upload`, {
        method: 'POST',
        headers,
        body: formData,
      });
    } catch {
      throw new Error('network');
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, json?.error ?? `HTTP ${res.status}`);
    return { filename: json?.filename ?? '' };
  }

  async restoreBackup(filename: string): Promise<void> {
    await this.request('POST', `/backups/${encodeURIComponent(filename)}/restore`);
  }

  async deleteBackup(filename: string): Promise<void> {
    await this.request('DELETE', `/backups/${encodeURIComponent(filename)}`);
  }

  // ===== Users =====

  async listUserProfiles(): Promise<UserProfile[]> {
    return this.request<UserProfile[]>('GET', '/users/profiles', { withUserId: false });
  }

  async updateMe(payload: {
    username?: string;
    first_name?: string;
    last_name?: string;
    email?: string;
  }): Promise<void> {
    await this.request('PATCH', '/users/me', { body: payload, withUserId: false });
  }

  async changeMyPassword(currentPassword: string, newPassword: string): Promise<void> {
    await this.request('POST', '/users/me/password', {
      body: {
        current_password: currentPassword,
        new_password: newPassword,
        confirm_password: newPassword,
      },
      withUserId: false,
    });
  }

  async getMyPasswordStatus(): Promise<{ is_default?: boolean; [key: string]: unknown }> {
    return this.request('GET', '/users/me/password-status', { withUserId: false });
  }

  async lookupUser(username: string): Promise<UserProfile> {
    return this.request<UserProfile>(
      'GET',
      `/users/lookup/${encodeURIComponent(username)}`,
      { withUserId: false },
    );
  }

  // ===== Admin =====

  async adminListUsers(): Promise<UserProfile[]> {
    const res = await this.request<{ success: boolean; users?: UserProfile[] } | UserProfile[]>(
      'GET',
      '/admin/users',
      { withUserId: false },
    );
    if (Array.isArray(res)) return res;
    return res.users ?? [];
  }

  async adminCreateUser(payload: { username: string }): Promise<void> {
    await this.request('POST', '/admin/users', { body: payload, withUserId: false });
  }

  async adminGetUser(id: number): Promise<UserProfile> {
    return this.request<UserProfile>('GET', `/admin/users/${id}`, { withUserId: false });
  }

  async adminUpdateUser(
    id: number,
    payload: { username?: string; active?: boolean; is_admin?: boolean },
  ): Promise<void> {
    await this.request('PATCH', `/admin/users/${id}`, { body: payload, withUserId: false });
  }

  async adminDeleteUser(id: number): Promise<void> {
    await this.request('DELETE', `/admin/users/${id}`, { withUserId: false });
  }

  async adminResetPassword(id: number, newPassword: string): Promise<void> {
    await this.request('POST', `/admin/users/${id}/reset-password`, {
      body: { action: 'set_password', new_password: newPassword },
      withUserId: false,
    });
  }

  async adminGetPasswordStatus(id: number): Promise<{ is_default?: boolean }> {
    return this.request('GET', `/admin/users/${id}/password-status`, { withUserId: false });
  }

  async adminGetStats(): Promise<AdminStats> {
    return this.request<AdminStats>('GET', '/admin/stats', { withUserId: false });
  }

  async adminRepair(): Promise<void> {
    await this.request('POST', '/admin/repair', { withUserId: false });
  }
}
