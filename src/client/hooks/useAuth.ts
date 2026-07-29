import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { get, post } from "../api";

interface AuthState {
  authenticated: boolean;
  user: { id: string; email?: string } | null;
  loading: boolean;
  isInitializing: boolean;
  passwordResetPending: boolean;
  setupComplete: boolean;
}

interface AuthProviderState {
  auth: AuthState;
  retryPending: boolean;
}

interface AuthStatusResponse {
  authenticated: boolean;
  user: { id: string; email?: string } | null;
  isInitializing?: boolean;
  passwordResetPending?: boolean;
  setupComplete?: boolean;
}

export function applyAuthStatusSuccess(
  _state: AuthProviderState,
  status: AuthStatusResponse
): AuthProviderState {
  return {
    auth: {
      authenticated: status.authenticated,
      user: status.user,
      loading: false,
      isInitializing: !!status.isInitializing,
      passwordResetPending: !!status.passwordResetPending,
      setupComplete: !!status.setupComplete,
    },
    retryPending: false,
  };
}

export function applyAuthStatusFailure(state: AuthProviderState): AuthProviderState {
  return {
    auth: {
      ...state.auth,
      loading: state.auth.authenticated ? false : state.auth.loading,
    },
    retryPending: true,
  };
}

export function shouldPollAuthStatus(state: AuthState, retryPending: boolean): boolean {
  return state.loading || state.isInitializing || retryPending;
}

interface AuthContextValue extends AuthState {
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue>({
  authenticated: false,
  user: null,
  loading: true,
  isInitializing: false,
  passwordResetPending: false,
  setupComplete: false,
  refresh: async () => {},
  signOut: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function useAuthProvider(): AuthContextValue {
  const [providerState, setProviderState] = useState<AuthProviderState>({
    auth: {
      authenticated: false,
      user: null,
      loading: true,
      isInitializing: false,
      passwordResetPending: false,
      setupComplete: false,
    },
    retryPending: false,
  });
  const { auth: state, retryPending } = providerState;

  const refresh = useCallback(async () => {
    try {
      const status = await get<AuthStatusResponse>("/api/auth/status");
      setProviderState((current) => applyAuthStatusSuccess(current, status));
    } catch {
      setProviderState(applyAuthStatusFailure);
    }
  }, []);

  const signOut = useCallback(async () => {
    await post("/api/auth/signout");
    setProviderState((current) => ({
      auth: {
        authenticated: false,
        user: null,
        loading: false,
        isInitializing: false,
        passwordResetPending: false,
        setupComplete: current.auth.setupComplete,
      },
      retryPending: false,
    }));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!shouldPollAuthStatus(state, retryPending)) return;
    const id = setInterval(() => {
      refresh();
    }, 2000);
    return () => clearInterval(id);
  }, [state.loading, state.isInitializing, retryPending, refresh]);

  return { ...state, refresh, signOut };
}
