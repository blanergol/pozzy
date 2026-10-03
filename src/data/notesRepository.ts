import { PoznoteClient } from '../api/client';
import { CreateNotePayload, Folder, NoteListItem, UpdateNotePayload } from '../api/types';
import {
  CachedNote,
  OfflineData,
  PendingOp,
  loadOfflineData,
  makeOpId,
  resolveNoteId,
  saveOfflineData,
} from '../storage/offlineStore';
import { bumpDataVersion } from '../utils/freshness';

/**
 * Repository call context. profileId === null (no active profile — e.g. in tests)
 * disables the cache and the queue: a pure pass-through to the client.
 */
export interface RepoContext {
  client: PoznoteClient;
  profileId: string | null;
  isOnline: boolean;
  reportNetworkError: () => void;
  reportSuccess: () => void;
}

export interface ListNotesFilter {
  workspace?: string;
  folder_id?: number;
  search?: string;
  sort?: 'updated_desc' | 'created_desc' | 'heading_asc';
}

function isNetworkError(e: unknown): boolean {
  return e instanceof Error && e.message === 'network';
}

/** Negative id = a local note not yet created on the server. */
export function isTempNoteId(id: number): boolean {
  return id < 0;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Search/filters on top of the local cache (a simplified version of the server logic). */
function filterList(list: NoteListItem[], params: ListNotesFilter): NoteListItem[] {
  let result = list;
  if (params.workspace) result = result.filter((n) => n.workspace === params.workspace);
  if (params.folder_id !== undefined) result = result.filter((n) => n.folder_id === params.folder_id);
  const q = params.search?.trim().toLowerCase();
  if (q) {
    result = result.filter(
      (n) =>
        (n.heading ?? '').toLowerCase().includes(q) ||
        (n.tags ?? '').toLowerCase().includes(q),
    );
  }
  const sort = params.sort ?? 'updated_desc';
  return [...result].sort((a, b) => {
    if (sort === 'heading_asc') return (a.heading ?? '').localeCompare(b.heading ?? '');
    const av = sort === 'created_desc' ? a.created : a.updated;
    const bv = sort === 'created_desc' ? b.created : b.updated;
    return bv.localeCompare(av);
  });
}

/** Update a list item from the full note data. */
function applyNoteToList(list: NoteListItem[], note: CachedNote): void {
  const item = list.find((n) => n.id === note.id);
  if (!item) return;
  item.heading = note.heading;
  item.tags = note.tags;
  item.updated = note.localUpdatedAt ?? note.updated ?? item.updated;
  item.folder = note.folder;
  item.folder_id = note.folder_id;
  item.workspace = note.workspace;
}

/** Apply pending operations on top of a fresh server snapshot (on online load). */
function applyPendingToData(data: OfflineData): void {
  for (const op of data.pending) {
    const id = resolveNoteId(data, op.noteId);
    if (op.type === 'update') {
      const details = data.notesDetails[String(id)];
      if (details) {
        if (op.payload.heading !== undefined) details.heading = op.payload.heading;
        if (op.payload.content !== undefined) details.content = op.payload.content;
        if (op.payload.tags !== undefined) details.tags = op.payload.tags;
        details.localUpdatedAt = op.clientTs;
        applyNoteToList(data.notesList, details);
      } else {
        const item = data.notesList.find((n) => n.id === id);
        if (item) {
          if (op.payload.heading !== undefined) item.heading = op.payload.heading;
          if (op.payload.tags !== undefined) item.tags = op.payload.tags ?? null;
          item.updated = op.clientTs;
        }
      }
    } else if (op.type === 'delete') {
      data.notesList = data.notesList.filter((n) => n.id !== id);
      delete data.notesDetails[String(id)];
    } else if (op.type === 'favorite') {
      const item = data.notesList.find((n) => n.id === id);
      if (item) item.favorite = op.payload.favorite ?? item.favorite;
    } else if (op.type === 'create') {
      // a note created offline is already in the cache — nothing to do
    }
  }
}

async function withData(
  ctx: RepoContext,
  mutate: (data: OfflineData) => void,
): Promise<OfflineData | null> {
  if (!ctx.profileId) return null;
  const data = await loadOfflineData(ctx.profileId);
  mutate(data);
  await saveOfflineData(ctx.profileId, data);
  return data;
}

// ===== Reads =====

export async function repoListNotes(
  ctx: RepoContext,
  params: ListNotesFilter,
): Promise<{ notes: NoteListItem[]; fromCache: boolean }> {
  if (ctx.profileId && ctx.isOnline) {
    try {
      const notes = await ctx.client.listNotes({
        workspace: params.workspace,
        folder_id: params.folder_id,
        search: params.search,
        sort: params.sort,
      });
      ctx.reportSuccess();
      // Only the FULL (unfiltered) list goes into the cache — otherwise only the
      // notes from the current filter would remain visible offline. Filtered
      // responses are returned as is; the cache is refreshed on the next full
      // request and during sync (syncNow pulls the full list).
      const isFullList = !params.search && params.folder_id === undefined && !params.workspace;
      if (isFullList) {
        const data = await withData(ctx, (d) => {
          d.notesList = notes;
          applyPendingToData(d);
        });
        return { notes: data ? filterList(data.notesList, params) : notes, fromCache: false };
      }
      return { notes, fromCache: false };
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      ctx.reportNetworkError();
      // fall through to the cache
    }
  }
  if (ctx.profileId) {
    const data = await loadOfflineData(ctx.profileId);
    return { notes: filterList(data.notesList, params), fromCache: true };
  }
  // no profile: direct call (tests)
  const notes = await ctx.client.listNotes({
    workspace: params.workspace,
    folder_id: params.folder_id,
    search: params.search,
    sort: params.sort,
  });
  return { notes, fromCache: false };
}

export async function repoGetNote(ctx: RepoContext, id: number): Promise<CachedNote> {
  if (ctx.profileId) {
    const data = await loadOfflineData(ctx.profileId);
    const resolvedId = resolveNoteId(data, id);
    const cached = data.notesDetails[String(resolvedId)] ?? data.notesDetails[String(id)];
    if (ctx.isOnline && !isTempNoteId(resolvedId)) {
      try {
        const fresh = await ctx.client.getNote(resolvedId);
        ctx.reportSuccess();
        // Don't overwrite local edits that are waiting to be synced
        const pendingUpdate = data.pending.find(
          (op) => op.type === 'update' && resolveNoteId(data, op.noteId) === resolvedId,
        );
        const merged: CachedNote = { ...fresh };
        if (pendingUpdate) {
          if (pendingUpdate.payload.heading !== undefined) merged.heading = pendingUpdate.payload.heading;
          if (pendingUpdate.payload.content !== undefined) merged.content = pendingUpdate.payload.content;
          if (pendingUpdate.payload.tags !== undefined) merged.tags = pendingUpdate.payload.tags;
          merged.localUpdatedAt = pendingUpdate.clientTs;
        }
        await withData(ctx, (d) => {
          d.notesDetails[String(resolvedId)] = merged;
        });
        return merged;
      } catch (e) {
        if (!isNetworkError(e)) throw e;
        ctx.reportNetworkError();
        if (cached) return cached;
        throw e;
      }
    }
    if (cached) return cached;
    if (isTempNoteId(resolvedId)) throw new Error('network');
  }
  return ctx.client.getNote(id);
}

export async function repoListFolders(
  ctx: RepoContext,
  workspace?: string,
): Promise<{ folders: Folder[]; fromCache: boolean }> {
  if (ctx.profileId && ctx.isOnline) {
    try {
      const folders = await ctx.client.listFolders(workspace);
      ctx.reportSuccess();
      if (!workspace) {
        await withData(ctx, (d) => {
          d.folders = folders;
        });
      }
      return { folders, fromCache: false };
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      ctx.reportNetworkError();
    }
  }
  if (ctx.profileId) {
    const data = await loadOfflineData(ctx.profileId);
    // folders have no workspace binding in the type — return the cache as is
    return { folders: data.folders, fromCache: true };
  }
  return { folders: await ctx.client.listFolders(workspace), fromCache: false };
}

// ===== Writes =====

export async function repoUpdateNote(
  ctx: RepoContext,
  id: number,
  payload: UpdateNotePayload,
  editorSessionId?: string,
): Promise<void> {
  bumpDataVersion();
  if (ctx.profileId) {
    const data = await loadOfflineData(ctx.profileId);
    const resolvedId = resolveNoteId(data, id);
    if (ctx.isOnline && !isTempNoteId(resolvedId)) {
      try {
        await ctx.client.updateNote(resolvedId, payload, editorSessionId);
        ctx.reportSuccess();
        await withData(ctx, (d) => {
          const details = d.notesDetails[String(resolvedId)];
          if (details) {
            if (payload.heading !== undefined) details.heading = payload.heading;
            if (payload.content !== undefined) details.content = payload.content;
            if (payload.tags !== undefined) details.tags = payload.tags;
            delete details.localUpdatedAt;
            applyNoteToList(d.notesList, details);
          }
          // the local edit has reached the server — remove it from the queue
          d.pending = d.pending.filter(
            (op) => !(op.type === 'update' && resolveNoteId(d, op.noteId) === resolvedId),
          );
        });
        return;
      } catch (e) {
        if (!isNetworkError(e)) throw e;
        ctx.reportNetworkError();
        // fall through to the offline write
      }
    }
    // Offline: cache + queue. If there is a pending create, merge the edits into it.
    await withData(ctx, (d) => {
      const ts = nowIso();
      const key = String(resolvedId);
      const details = d.notesDetails[key];
      if (details) {
        if (payload.heading !== undefined) details.heading = payload.heading;
        if (payload.content !== undefined) details.content = payload.content;
        if (payload.tags !== undefined) details.tags = payload.tags;
        details.localUpdatedAt = ts;
        applyNoteToList(d.notesList, details);
      } else {
        const item = d.notesList.find((n) => n.id === resolvedId);
        if (item) {
          if (payload.heading !== undefined) item.heading = payload.heading;
          if (payload.tags !== undefined) item.tags = payload.tags ?? null;
          item.updated = ts;
        }
      }
      const createOp = d.pending.find(
        (op) => op.type === 'create' && resolveNoteId(d, op.noteId) === resolvedId,
      );
      if (createOp) {
        Object.assign(createOp.payload, payload);
        createOp.clientTs = ts;
        return;
      }
      const updateOp = d.pending.find(
        (op) => op.type === 'update' && resolveNoteId(d, op.noteId) === resolvedId,
      );
      if (updateOp) {
        Object.assign(updateOp.payload, payload);
        updateOp.clientTs = ts;
      } else {
        d.pending.push({ opId: makeOpId(), type: 'update', noteId: resolvedId, payload: { ...payload }, clientTs: ts });
      }
    });
    return;
  }
  await ctx.client.updateNote(id, payload, editorSessionId);
}

export async function repoCreateNote(
  ctx: RepoContext,
  payload: CreateNotePayload,
): Promise<number> {
  bumpDataVersion();
  if (ctx.profileId && !ctx.isOnline) {
    const tempId = -Date.now();
    await withData(ctx, (d) => {
      const ts = nowIso();
      const note: CachedNote = {
        id: tempId,
        heading: payload.heading,
        content: payload.content ?? '',
        tags: payload.tags ?? null,
        workspace: payload.workspace ?? null,
        folder: null,
        folder_id: payload.folder_id ?? null,
        type: payload.type ?? 'note',
        linked_note_id: null,
        icon: null,
        icon_color: null,
        color: null,
        color_hex: null,
        reminder_at: null,
        created: ts,
        updated: ts,
        localUpdatedAt: ts,
      };
      d.notesDetails[String(tempId)] = note;
      d.notesList.unshift({
        id: tempId,
        heading: note.heading,
        type: note.type,
        tags: note.tags,
        folder: null,
        folder_id: note.folder_id,
        workspace: note.workspace,
        updated: ts,
        created: ts,
        favorite: 0,
        icon: null,
        icon_color: null,
        color: null,
        color_hex: null,
      });
      d.pending.push({
        opId: makeOpId(),
        type: 'create',
        noteId: tempId,
        payload: {
          heading: payload.heading,
          content: payload.content ?? '',
          tags: payload.tags,
          workspace: payload.workspace,
          folder_id: payload.folder_id ?? null,
        },
        clientTs: ts,
      });
    });
    return tempId;
  }
  if (ctx.profileId) {
    try {
      const id = await ctx.client.createNote(payload);
      ctx.reportSuccess();
      return id;
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      ctx.reportNetworkError();
      return repoCreateNote({ ...ctx, isOnline: false }, payload);
    }
  }
  return ctx.client.createNote(payload);
}

export async function repoDeleteNote(ctx: RepoContext, id: number): Promise<void> {
  bumpDataVersion();
  if (ctx.profileId) {
    const data = await loadOfflineData(ctx.profileId);
    const resolvedId = resolveNoteId(data, id);
    if (ctx.isOnline && !isTempNoteId(resolvedId)) {
      try {
        await ctx.client.deleteNote(resolvedId);
        ctx.reportSuccess();
        await withData(ctx, (d) => {
          d.notesList = d.notesList.filter((n) => n.id !== resolvedId);
          delete d.notesDetails[String(resolvedId)];
          d.pending = d.pending.filter((op) => resolveNoteId(d, op.noteId) !== resolvedId);
        });
        return;
      } catch (e) {
        if (!isNetworkError(e)) throw e;
        ctx.reportNetworkError();
      }
    }
    await withData(ctx, (d) => {
      d.notesList = d.notesList.filter((n) => n.id !== resolvedId);
      delete d.notesDetails[String(resolvedId)];
      const hadCreate = d.pending.some(
        (op) => op.type === 'create' && resolveNoteId(d, op.noteId) === resolvedId,
      );
      // remove all pending operations for the note
      d.pending = d.pending.filter((op) => resolveNoteId(d, op.noteId) !== resolvedId);
      if (!hadCreate && !isTempNoteId(resolvedId)) {
        d.pending.push({
          opId: makeOpId(),
          type: 'delete',
          noteId: resolvedId,
          payload: {},
          clientTs: nowIso(),
        });
      }
    });
    return;
  }
  await ctx.client.deleteNote(id);
}

export async function repoToggleFavorite(ctx: RepoContext, id: number): Promise<void> {
  bumpDataVersion();
  if (ctx.profileId) {
    const data = await loadOfflineData(ctx.profileId);
    const resolvedId = resolveNoteId(data, id);
    if (ctx.isOnline && !isTempNoteId(resolvedId)) {
      try {
        await ctx.client.toggleFavorite(resolvedId);
        ctx.reportSuccess();
        await withData(ctx, (d) => {
          const item = d.notesList.find((n) => n.id === resolvedId);
          if (item) item.favorite = item.favorite ? 0 : 1;
        });
        return;
      } catch (e) {
        if (!isNetworkError(e)) throw e;
        ctx.reportNetworkError();
      }
    }
    await withData(ctx, (d) => {
      const item = d.notesList.find((n) => n.id === resolvedId);
      const next = item ? (item.favorite ? 0 : 1) : 1;
      if (item) item.favorite = next;
      const existing = d.pending.find(
        (op) => op.type === 'favorite' && resolveNoteId(d, op.noteId) === resolvedId,
      );
      if (existing) {
        existing.payload.favorite = next;
        existing.clientTs = nowIso();
      } else {
        d.pending.push({
          opId: makeOpId(),
          type: 'favorite',
          noteId: resolvedId,
          payload: { favorite: next },
          clientTs: nowIso(),
        });
      }
    });
    return;
  }
  await ctx.client.toggleFavorite(id);
}
