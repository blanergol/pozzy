import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';

interface ConnectivityContextValue {
  /**
   * false = оффлайн-режим: нет сети или сервер недоступен.
   * Репозиторий в этом случае работает с локальным кэшем.
   */
  isOnline: boolean;
  /** Сигнал от сетевого слоя: fetch упал по сети (сервер недоступен). */
  reportNetworkError: () => void;
  /** Сигнал от сетевого слоя: запрос прошёл — сервер доступен. */
  reportSuccess: () => void;
}

const ConnectivityContext = createContext<ConnectivityContextValue>({
  isOnline: true,
  reportNetworkError: () => {},
  reportSuccess: () => {},
});

export function ConnectivityProvider({ children }: { children: React.ReactNode }) {
  const [networkUp, setNetworkUp] = useState(true);
  const [serverReachable, setServerReachable] = useState(true);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      // null (неизвестно) считаем онлайном — оптимистично
      const up = state.isConnected !== false;
      setNetworkUp(up);
      // Появление сети — повод снова попробовать сервер:
      // sync при ошибке вернёт serverReachable=false через reportNetworkError.
      if (up) setServerReachable(true);
    });
    return unsubscribe;
  }, []);

  const reportNetworkError = useCallback(() => {
    setServerReachable(false);
  }, []);

  const reportSuccess = useCallback(() => {
    setServerReachable(true);
  }, []);

  const value = useMemo<ConnectivityContextValue>(
    () => ({
      isOnline: networkUp && serverReachable,
      reportNetworkError,
      reportSuccess,
    }),
    [networkUp, serverReachable, reportNetworkError, reportSuccess],
  );

  return <ConnectivityContext.Provider value={value}>{children}</ConnectivityContext.Provider>;
}

export function useConnectivity(): ConnectivityContextValue {
  return useContext(ConnectivityContext);
}
