import { NavigatorScreenParams } from '@react-navigation/native';

export type MainTabParamList = {
  Notes: { folderId?: number; folderName?: string; focusSearch?: boolean } | undefined;
  Folders: undefined;
  Chat: undefined;
};

export type RootStackParamList = {
  Tabs: NavigatorScreenParams<MainTabParamList> | undefined;
  Settings: undefined;
  NoteEditor: { noteId: number; favorite?: number; startVoice?: boolean };
  FolderNotes: { folderId: number; folderName: string };
  Trash: undefined;
  Notifications: undefined;
};
