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
  /**
   * Does the signed-in user hold EVERY one of these permissions?
   *
   * This is for hiding buttons and menu items, and for nothing else. The server checks the
   * same keys on every route — `can()` here only spares somebody clicking something that
   * would be refused. An owner holds everything, which the server has already folded into
   * the permission list, so there is no special case to remember at each call site.
   */
  can: (...keys: string[]) => boolean;
  /** At least one of these — for a screen two different jobs reach. */
  canAny: (...keys: string[]) => boolean;
  isOwner: boolean;
  /**
   * Re-read who we are and what we may do.
   *
   * Needed because the permission list is fetched ONCE at mount and then held in state — it is
   * not a react-query cache, so invalidating a query key does nothing to it. Editing your own
   * role, or being moved to another one, changes what the server will allow on the very next
   * request; without this the menu goes on offering what has just started being refused until
   * somebody reloads the page.
   */
  refreshUser: () => Promise<void>;
}

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

  const refreshUser = useCallback(async () => {
    // A 401 is already handled by the interceptor, which clears the user; anything else is
    // left alone rather than signing somebody out over a dropped request.
    const res = await api.get<User>('/auth/me').catch(() => null);
    if (res) setUser(res.data);
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const held = new Set(user?.permissions ?? []);
    return {
      user,
      loading,
      login,
      logout,
      changePassword,
      can: (...keys) => keys.length > 0 && keys.every((k) => held.has(k)),
      canAny: (...keys) => keys.some((k) => held.has(k)),
      isOwner: user?.isOwner ?? false,
      refreshUser,
    };
  }, [user, loading, login, logout, changePassword, refreshUser]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
