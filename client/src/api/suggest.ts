import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from './client';

/**
 * "What did we use last time?"
 *
 * Every figure here is derived by the server from the live records, so there is nothing
 * to cache-bust beyond the ordinary query keys. Sources are kept separate on purpose:
 * what a line was costed at and what a supplier actually billed are different facts.
 */

export interface Occurrence {
  value: number;
  date: string;
  /** Where it came from, e.g. `AB-00123 — Crazy Almirah`. */
  label: string;
  detail?: string | null;
  unit?: string | null;
  qty?: number | null;
  link?: { type: 'product' | 'order' | 'proforma' | 'stock' | 'worker'; id: number } | null;
}

export interface SourceStats {
  kind: string;
  label: string;
  count: number;
  last: Occurrence | null;
  min: number;
  max: number;
  avg: number;
  occurrences: Occurrence[];
}

export interface OutlierVerdict {
  flag: 'HIGH' | 'LOW' | null;
  pct: number;
  reference: number;
  count: number;
}

export interface Suggestion {
  key: string;
  name: string;
  sources: SourceStats[];
  /** The source to lead with — the most directly comparable one that has history. */
  primary: SourceStats | null;
  outlier: OutlierVerdict;
}

export interface CostLineQuery {
  name: string;
  groupName?: string;
  head?: string;
  stageStepId?: number | null;
  value?: number | null;
}

export interface AppSettings {
  /** ORDER (the default) or INVOICE — see the Sales tab in Master Data. */
  receivableBasis?: 'ORDER' | 'INVOICE';
  id: number;
  suggestionWindowDays: number;
  outlierPct: number;
}

const get = async <T>(url: string, params?: Record<string, unknown>) => (await api.get<T>(url, { params })).data;

export const useAppSettings = () => useQuery({ queryKey: ['app-settings'], queryFn: () => get<AppSettings>('/app-settings') });

/**
 * History for every line of a cost sheet at once.
 *
 * A POST because the question is a list, not a URL — and asking per field would mean a
 * round-trip per row on a sheet that routinely has forty of them.
 */
export function useCostLineSuggestions(productId: number | null | undefined, lines: CostLineQuery[], enabled = true) {
  const key = lines.map((l) => `${l.name}|${l.groupName ?? ''}|${l.stageStepId ?? ''}`).join('~');
  return useQuery({
    enabled: enabled && lines.length > 0,
    queryKey: ['suggest-cost-lines', productId ?? 'new', key],
    // The figures move only when someone saves a product, a receipt or an order.
    staleTime: 60_000,
    queryFn: async () =>
      (
        await api.post<{ windowDays: number; outlierPct: number; suggestions: Suggestion[] }>('/suggest/cost-lines', {
          productId: productId ?? null,
          // Values are left out of the batch: the outlier check runs client-side so it
          // updates as you type, without a request per keystroke.
          lines: lines.map((l) => ({ name: l.name, groupName: l.groupName, head: l.head, stageStepId: l.stageStepId ?? null })),
        })
      ).data,
  });
}

export const usePriceSuggestion = (productId?: number | null, buyerId?: number | null, currency?: string | null, enabled = true) =>
  useQuery({
    enabled: enabled && !!productId,
    queryKey: ['suggest-price', productId, buyerId ?? 'any', currency ?? 'any'],
    staleTime: 60_000,
    queryFn: () => get<Suggestion & { windowDays: number; outlierPct: number; currency: string | null }>('/suggest/price', { productId, buyerId: buyerId ?? undefined, currency: currency ?? undefined }),
  });

export const useRateSuggestion = (params: { kind: 'JOBWORK' | 'LABOUR' | 'PURCHASE' | 'WORKER'; stage?: string; vendorId?: number | null; rawItemId?: number | null; supplierId?: number | null; tradeId?: number | null; payType?: string }, enabled = true) =>
  useQuery({
    enabled: enabled && (params.kind === 'WORKER' || !!params.stage || !!params.rawItemId),
    queryKey: ['suggest-rate', params],
    staleTime: 60_000,
    queryFn: () =>
      get<Suggestion & { windowDays: number; outlierPct: number }>('/suggest/rate', {
        kind: params.kind,
        stage: params.stage,
        vendorId: params.vendorId ?? undefined,
        rawItemId: params.rawItemId ?? undefined,
        supplierId: params.supplierId ?? undefined,
        tradeId: params.tradeId ?? undefined,
        payType: params.payType,
      }),
  });

// ---------------------------------------------------------------------------
// The change log
// ---------------------------------------------------------------------------

export type ChangeRoot = 'Product' | 'Order' | 'Proforma' | 'Worker' | 'StatutoryComponent' | 'Contractor' | 'RawItem';

export interface ChangeLogRow {
  id: number;
  entity: string;
  entityId: number | null;
  rootType: string;
  rootId: number;
  field: string;
  label: string;
  oldValue: string | null;
  newValue: string | null;
  note: string | null;
  userId: number | null;
  userName: string;
  at: string;
}

export const useChangeLog = (rootType?: ChangeRoot, rootId?: number | string) =>
  useQuery({
    enabled: !!rootType && rootId != null && rootId !== 'new',
    queryKey: ['change-log', rootType, rootId],
    queryFn: () => get<ChangeLogRow[]>('/change-log', { rootType, rootId }),
  });

/**
 * Is this figure out of line with the history?
 *
 * Mirrors the server's `outlier()` so the note can update as the user types without a
 * request per keystroke — keep the two in step.
 */
export function outlierOf(value: number | null | undefined, stats: SourceStats | null | undefined, pct: number): OutlierVerdict {
  const none: OutlierVerdict = { flag: null, pct: 0, reference: 0, count: stats?.count ?? 0 };
  if (!stats || stats.count < 2 || !value || value <= 0 || stats.avg <= 0) return none;
  const drift = ((value - stats.avg) / stats.avg) * 100;
  const rounded = Math.round(drift * 100) / 100;
  if (Math.abs(drift) < pct) return { ...none, pct: rounded, reference: stats.avg };
  return { flag: drift > 0 ? 'HIGH' : 'LOW', pct: rounded, reference: stats.avg, count: stats.count };
}

export const useSaveAppSettings = () => useMutation({ mutationFn: (body: Partial<AppSettings>) => api.put('/app-settings', body) });
