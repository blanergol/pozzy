import { translate } from '../../i18n';
import { err, resolveFolderId } from '../toolHelpers';
import { PoznoteTool } from './types';

/** Folder tools: create, rename, empty, delete. */
export const FOLDER_TOOLS: PoznoteTool[] = [
  {
    spec: {
      name: 'create_folder',
      description: 'Create a new folder.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Folder name' },
          workspace: { type: 'string', description: 'Workspace name' },
        },
        required: ['name'],
      },
    },
    run: async (client, args) => {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (!name) return err('name is required');
      const id = await client.createFolder({
        name,
        workspace: typeof args.workspace === 'string' && args.workspace.trim() ? args.workspace.trim() : undefined,
      });
      return JSON.stringify({ id, name });
    },
  },
  {
    spec: {
      name: 'rename_folder',
      description: 'Rename a folder.',
      parameters: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: 'Current folder name' },
          new_name: { type: 'string', description: 'New folder name' },
        },
        required: ['folder', 'new_name'],
      },
    },
    run: async (client, args) => {
      const folderId = await resolveFolderId(client, args.folder);
      if (typeof folderId === 'string') return folderId;
      const newName = typeof args.new_name === 'string' ? args.new_name.trim() : '';
      if (!newName) return err('new_name is required');
      await client.renameFolder(folderId, newName);
      return JSON.stringify({ ok: true, id: folderId, name: newName });
    },
  },
  {
    spec: {
      name: 'empty_folder',
      description: 'Move all notes of a folder to trash (folder itself stays). Requires user approval.',
      parameters: {
        type: 'object',
        properties: { folder: { type: 'string', description: 'Folder name' } },
        required: ['folder'],
      },
    },
    requiresApproval: true,
    approvalPreview: async (client, args) => {
      const folderId = await resolveFolderId(client, args.folder);
      if (typeof folderId === 'string') return translate('chat.approvalGeneric', { tool: 'empty_folder' });
      const count = await client.getFolderNoteCount(folderId);
      return translate('chat.approvalEmptyFolder', { name: String(args.folder), count });
    },
    run: async (client, args) => {
      const folderId = await resolveFolderId(client, args.folder);
      if (typeof folderId === 'string') return folderId;
      await client.emptyFolder(folderId);
      return JSON.stringify({ ok: true, id: folderId });
    },
  },
  {
    spec: {
      name: 'delete_folder',
      description: 'Delete a folder (notes inside are kept, they become uncategorized). Requires user approval.',
      parameters: {
        type: 'object',
        properties: { folder: { type: 'string', description: 'Folder name' } },
        required: ['folder'],
      },
    },
    requiresApproval: true,
    approvalPreview: async (_client, args) =>
      translate('chat.approvalDeleteFolder', { name: String(args.folder ?? '') }),
    run: async (client, args) => {
      const folderId = await resolveFolderId(client, args.folder);
      if (typeof folderId === 'string') return folderId;
      await client.deleteFolder(folderId);
      return JSON.stringify({ ok: true, id: folderId });
    },
  },
];
