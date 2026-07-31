/**
 * Roles and the permission catalogue.
 *
 * The catalogue is FETCHED, not mirrored. Costing, pricing and shipping keep byte-identical
 * copies on both sides because they are arithmetic the UI has to do live; a permission
 * catalogue is static prose that only the Roles screen renders, so one copy on the server and
 * an endpoint is strictly better — there is nothing that can drift.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { PermissionDef, Role } from './types';

export interface PermissionCatalogue {
  modules: { module: string; permissions: PermissionDef[] }[];
  permissions: PermissionDef[];
}

/** Static for the life of a release, so it is cached hard rather than refetched per visit. */
export function usePermissionCatalogue(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['permission-catalogue'],
    queryFn: async () => (await api.get<PermissionCatalogue>('/roles/permissions')).data,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

export function useRoles(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['roles'],
    queryFn: async () => (await api.get<Role[]>('/roles')).data,
  });
}

export interface RoleInput {
  name: string;
  description?: string;
  isActive?: boolean;
  permissions: string[];
}

export function useSaveRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: RoleInput & { id?: number }) =>
      id ? (await api.put<Role>(`/roles/${id}`, body)).data : (await api.post<Role>('/roles', body)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['roles'] });
      // A role change can alter what the signed-in user may do, and the server resolves
      // permissions live — so the identity behind `can()` has to be refetched too, or the
      // menu would keep showing what the server has just started refusing.
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
}

export function useDeleteRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await api.delete(`/roles/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['roles'] });
      qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
}

/**
 * Close a tick over its prerequisites, the same way the server does when it saves.
 *
 * Ticking "Edit orders" without "See orders" would store a role that cannot open the page it
 * edits. The server closes the set anyway; doing it here as well is what lets the screen SHOW
 * what it is about to do rather than silently adding boxes after the save.
 */
export function withRequired(keys: Iterable<string>, defs: PermissionDef[]): string[] {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const out = new Set<string>();
  const walk = (key: string) => {
    if (out.has(key)) return;
    const def = byKey.get(key);
    if (!def) return;
    out.add(key);
    for (const req of def.requires ?? []) walk(req);
  };
  for (const k of keys) walk(k);
  return [...out];
}

/**
 * Which OTHER permissions in the set depend on this one — so unticking a view permission can
 * say what it is about to take with it instead of quietly leaving an unusable role.
 */
export function dependents(key: string, held: Iterable<string>, defs: PermissionDef[]): string[] {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const heldSet = new Set(held);
  return [...heldSet].filter((k) => k !== key && (byKey.get(k)?.requires ?? []).includes(key));
}
