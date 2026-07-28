export type RootStackParamList = {
  Settings: undefined;
  NotesList: { folderId?: number; folderName?: string } | undefined;
  NoteEditor: { noteId: number; favorite?: number };
  Folders: undefined;
  Trash: undefined;
  Notifications: undefined;
};
