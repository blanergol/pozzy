import { createNavigationContainerRef } from '@react-navigation/native';
import { RootStackParamList } from './types';

/** Ref to the root navigation — for navigating from outside React (notification tap, share intent). */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();
