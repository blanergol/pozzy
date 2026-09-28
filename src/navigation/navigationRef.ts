import { createNavigationContainerRef } from '@react-navigation/native';
import { RootStackParamList } from './types';

/** Ссылка на корневую навигацию — для переходов извне React (тап по уведомлению, share intent). */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();
