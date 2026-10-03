import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { __resetOfflineMemoryForTests } from '../src/storage/offlineStore';
import { __resetDataKeyCacheForTests } from '../src/storage/secure/encryptedCache';
import { __resetMigrationForTests } from '../src/storage/secure/migration';

/** expo-secure-store mock (test/mocks/expo-secure-store.js) with test helpers. */
export const secureStoreMock = SecureStore as unknown as {
  __store: Map<string, string>;
  __calls: { op: string; key: string; options?: Record<string, unknown> }[];
  __reset(): void;
  __failNext(op: 'get' | 'set' | 'delete', times?: number): void;
  __setCorruptReads(value: boolean): void;
  __setInterceptor(fn: ((op: string) => void) | null): void;
};

type AsyncStorageMock = typeof AsyncStorage & { __INTERNAL_MOCK_STORAGE__: Record<string, string> };
const asMock = AsyncStorage as AsyncStorageMock;

/** Raw AsyncStorage values (as they are stored on disk). */
export function rawAsyncStorage(): Record<string, string> {
  return asMock.__INTERNAL_MOCK_STORAGE__;
}

/** Simulates an app restart: in-memory module state is reset. */
export function restartApp(): void {
  __resetOfflineMemoryForTests();
  __resetDataKeyCacheForTests();
  __resetMigrationForTests();
}

/** Clean device: empty AsyncStorage and SecureStore. */
export async function wipeDevice(): Promise<void> {
  await AsyncStorage.clear();
  secureStoreMock.__reset();
  restartApp();
  installCrashHooks();
}

// ===== Simulating a process crash on the N-th storage operation =====

let budget: number | null = null;
let ops = 0;

function tick(): void {
  ops++;
  if (budget !== null && ops > budget) throw new Error('simulated crash');
}

const WRAPPED = ['getItem', 'setItem', 'removeItem', 'multiGet', 'multiSet', 'multiRemove', 'getAllKeys'] as const;
let wrapped = false;

export function installCrashHooks(): void {
  secureStoreMock.__setInterceptor(tick);
  if (wrapped) return;
  wrapped = true;
  const target = asMock as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const name of WRAPPED) {
    const original = target[name];
    target[name] = async (...args: unknown[]) => {
      tick();
      return original(...args);
    };
  }
}

/** All operations after the n-th throw, as if the process had died. */
export function crashAfter(n: number): void {
  ops = 0;
  budget = n;
}

export function stopCrashing(): void {
  budget = null;
  ops = 0;
}

export function operationCount(): number {
  return ops;
}
