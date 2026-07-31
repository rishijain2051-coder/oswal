import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, setUnauthorizedHandler, TOKEN_KEY } from '../api/client';
import type { User } from '../api/types';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  /** Anyone may rotate their own password without an Admin. */
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  hasRole: (min: 'Viewer' | 'Operator' | 'Manager' | 'Admin') => boolean;
}

const RANK: Record<string, number> = { Viewer: 1, Operator: 2, Manager: 3, Admin: 4 };

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      localStorage.removeItem(TOKEN_KEY);
      setUser(null);
    });
  }, []);

  useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setLoading(false);
      return;
    }
    api
      .get<User>('/auth/me')
      .then((res) => setUser(res.data))
      .catch(() => localStorage.removeItem(TOKEN_KEY))
      .finally(() => setLoading(false));
  }, []);

  /**
   * Quietly renew the session while someone is working. A shift on the factory floor
   * outlasts the token, and being thrown out mid-entry loses whatever was on screen.
   *
   * A failed renewal is RETRIED SOON rather than left until the next half-hour slot. The
   * factory's network drops, and a renewal that failed on a five-minute outage used to wait
   * out the full interval — enough of those in a row and a 12-hour token expires while
   * somebody is still typing, which the 401 handler turns into being logged out mid-entry.
   * A real 401 is not retried: the token is already gone and the handler has dealt with it.
   */
  const renewFailures = useRef(0);
  useEffect(() => {
    if (!user) return;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const renew = () => {
      api
        .post<{ token: string; user: User }>('/auth/refresh')
        .then((res) => {
          localStorage.setItem(TOKEN_KEY, res.data.token);
          renewFailures.current = 0;
        })
        .catch((err) => {
          // No response at all means the server was unreachable — worth another go. A 401
          // means the session is genuinely over and retrying would only repeat it.
          if (err?.response) return;
          renewFailures.current += 1;
          // Back off, but never further out than the ordinary interval.
          const wait = Math.min(30 * 60 * 1000, 60 * 1000 * 2 ** Math.min(renewFailures.current - 1, 4));
          clearTimeout(retry);
          retry = setTimeout(renew, wait);
        });
    };
    const timer = setInterval(renew, 30 * 60 * 1000);
    const onFocus = () => renew();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      clearTimeout(retry);
      window.removeEventListener('focus', onFocus);
    };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // These three close over nothing but `setUser` and the module-level `api`, so memoising
  // them is not about avoiding renders — it is so the context value below can name them as
  // dependencies honestly. Left un-memoised, its dependency list was a lie that happened to
  // be harmless, and the first one of these to capture real state would have broken quietly.
  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ token: string; user: User }>('/auth/login', { email, password });
    localStorage.setItem(TOKEN_KEY, res.data.token);
    setUser(res.data.user);
  }, []);

  const logout = useCallback(() => {
    // Clears the upload cookie too; failure is fine, the local token is gone either way.
    api.post('/auth/logout').catch(() => undefined);
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const res = await api.post<{ token: string }>('/auth/change-password', { currentPassword, newPassword });
    localStorage.setItem(TOKEN_KEY, res.data.token);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      login,
      logout,
      changePassword,
      hasRole: (min) => (RANK[user?.role ?? ''] ?? 0) >= RANK[min],
    }),
    [user, loading, login, logout, changePassword]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
