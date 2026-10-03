import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';

interface ConnectivityContextValue {
  /**
   * false = offline mode: no network or the server is unreachable.
   * In that case the repository works with the local cache.
   */
  isOnline: boolean;
  /** Signal from the network layer: fetch failed with a network error (server unreachable). */
  reportNetworkError: () => void;
  /** Signal from the network layer: the request succeeded, the server is reachable. */
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
      // null (unknown) counts as online: optimistic
      const up = state.isConnected !== false;
      setNetworkUp(up);
      // Network coming back is a reason to retry the server:
      // on failure, sync will set serverReachable=false again via reportNetworkError.
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
