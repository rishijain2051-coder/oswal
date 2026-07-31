/**
 * Suggestion endpoints — "what did we use last time", assembled from the live records.
 *
 * Nothing here writes anything. Every figure is read out of cost sheets, stock
 * receipts, stage rates, orders and proformas at the moment it is asked for, so a
 * correction to the original is reflected immediately and there is no second copy to
 * go stale. See `lib/suggest.ts` for why the sources are kept separate.
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { ApiError, asyncHandler, guardIdParams } from '../lib/http';
import { authenticate, can, canAny, may } from '../middleware/auth';
import { round } from '../lib/costing';
import { assemble, normalizeKey, outlier, summarize, windowStart, type Occurrence, type SourceStats, type Suggestion } from '../lib/suggest';
import { CHANGE_ROOTS } from '../lib/changeLog';

const router = Router();
// A route param here is always a database id — see guardIdParams.
guardIdParams(router);
router.use(authenticate);

/** The window and tolerance the Admin has set. Created on first use. */
export async function appSetting() {
  return prisma.appSetting.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
}

// ---------------------------------------------------------------------------
// Cost lines — the big one
// ---------------------------------------------------------------------------

const lineQuery = z.object({
  /** The line's own name, e.g. `CARVING LABOUR` or `TOP`. */
  name: z.string(),
  /** The group it sits in, e.g. `Mango Wood` — this is what a raw item matches on. */
  groupName: z.string().optional(),
  head: z.string().optional(),
  /** Set on a LABOUR line mapped to a production stage. */
  stageStepId: z.number().int().nullable().optional(),
  /** The figure currently typed, so the reply can say whether it looks out of line. */
  value: z.number().nullable().optional(),
});

const batchSchema = z.object({
  /** Excluded from its own history, or every product would suggest itself. */
  productId: z.number().int().nullable().optional(),
  lines: z.array(lineQuery).max(200),
});

/**
 * History for a set of cost lines, in one request.
 *
 * The costing wizard has dozens of lines; asking per field would mean dozens of
 * round-trips and a table read for each. This does one pass over the window instead.
 */
router.post(
  '/suggest/cost-lines',
  can('suggestions.view'),
  asyncHandler(async (req, res) => {
    const body = batchSchema.parse(req.body);
    const setting = await appSetting();
    const since = windowStart(setting.suggestionWindowDays);

    const lineKeys = new Set(body.lines.map((l) => normalizeKey(l.name)).filter(Boolean));
    const groupKeys = new Set(body.lines.map((l) => normalizeKey(l.groupName)).filter(Boolean));
    const stepIds = [...new Set(body.lines.map((l) => l.stageStepId).filter((v): v is number => v != null))];

    // --- what the same line was costed at elsewhere -------------------------
    //
    // A cost sheet is REPLACED on every product save, so its createdAt is when these
    // rates were last set — a better date than the product's updatedAt, which moves
    // when anything at all changes.
    const costed = await prisma.costLine.findMany({
      where: {
        group: {
          costSheet: {
            isActive: true,
            // A product in the trash was removed for a reason; suggesting its rates back
            // would be offering the very figure somebody just rejected.
            product: { deletedAt: null },
            ...(since ? { createdAt: { gte: since } } : {}),
            ...(body.productId ? { productId: { not: body.productId } } : {}),
          },
        },
      },
      select: {
        name: true,
        rate: true,
        unit: true,
        qty: true,
        wastagePct: true,
        group: {
          select: {
            name: true,
            head: true,
            method: true,
            costSheet: { select: { createdAt: true, product: { select: { id: true, factoryCode: true, name: true } } } },
          },
        },
      },
    });

    const costedByKey = new Map<string, Occurrence[]>();
    for (const l of costed) {
      const key = normalizeKey(l.name);
      if (!lineKeys.has(key) || l.rate <= 0) continue;
      const p = l.group.costSheet.product;
      const list = costedByKey.get(key) ?? [];
      list.push({
        value: round(l.rate),
        date: l.group.costSheet.createdAt,
        label: `${p.factoryCode} — ${p.name}`,
        // The head is only worth showing when it adds something the group name does not
        // — "Labour · labour" is noise.
        detail: [l.group.name, normalizeKey(l.group.head.replace(/_/g, ' ')) === normalizeKey(l.group.name) ? null : l.group.head.replace(/_/g, ' ').toLowerCase(), l.wastagePct ? `${l.wastagePct}% wastage` : null]
          .filter(Boolean)
          .join(' · '),
        unit: l.unit,
        qty: l.qty,
        link: { type: 'product', id: p.id },
      });
      costedByKey.set(key, list);
    }

    // --- what a supplier actually billed for that material -----------------
    const rawItems = await prisma.rawItem.findMany({ select: { id: true, code: true, name: true, unit: true } });
    const itemsByKey = new Map<string, { id: number; code: string; name: string; unit: string }[]>();
    for (const it of rawItems) {
      for (const k of [normalizeKey(it.name), normalizeKey(it.code)]) {
        if (!k) continue;
        itemsByKey.set(k, [...(itemsByKey.get(k) ?? []), it]);
      }
    }
    const wantedItemIds = [...new Set([...groupKeys, ...lineKeys].flatMap((k) => (itemsByKey.get(k) ?? []).map((i) => i.id)))];
    const receipts = wantedItemIds.length
      ? await prisma.stockTxn.findMany({
          where: { type: 'IN', rawItemId: { in: wantedItemIds }, ...(since ? { date: { gte: since } } : {}) },
          select: { id: true, rate: true, qty: true, date: true, rawItem: { select: { id: true, code: true, name: true, unit: true } }, supplier: { select: { id: true, name: true } } },
        })
      : [];

    const purchasedByItem = new Map<number, Occurrence[]>();
    for (const t of receipts) {
      if (t.rate <= 0) continue;
      const list = purchasedByItem.get(t.rawItem.id) ?? [];
      list.push({
        value: round(t.rate),
        date: t.date,
        label: t.supplier?.name ?? 'Supplier not recorded',
        detail: `${t.rawItem.code} · ${round(t.qty, 3)} ${t.rawItem.unit} received`,
        unit: t.rawItem.unit,
        qty: t.qty,
        link: { type: 'stock', id: t.rawItem.id },
      });
      purchasedByItem.set(t.rawItem.id, list);
    }

    // --- what was actually paid out for that stage --------------------------
    const steps = stepIds.length ? await prisma.stageLineStep.findMany({ where: { id: { in: stepIds } }, select: { id: true, name: true } }) : [];
    const stepNameById = new Map(steps.map((s) => [s.id, normalizeKey(s.name)]));
    const stageNames = [...new Set(steps.map((s) => normalizeKey(s.name)))];

    const stages = stageNames.length
      ? await prisma.orderLineStage.findMany({
          where: { orderLine: { order: { status: { not: 'Cancelled' }, deletedAt: null, ...(since ? { orderDate: { gte: since } } : {}) } } },
          select: {
            name: true,
            jobworkRate: true,
            labourRate: true,
            vendor: { select: { id: true, name: true } },
            orderLine: { select: { order: { select: { id: true, number: true, orderDate: true } }, product: { select: { factoryCode: true } } } },
          },
        })
      : [];

    const jobworkByStage = new Map<string, Occurrence[]>();
    const labourByStage = new Map<string, Occurrence[]>();
    for (const s of stages) {
      const key = normalizeKey(s.name);
      if (!stageNames.includes(key)) continue;
      const o = s.orderLine.order;
      const base = { date: o.orderDate, link: { type: 'order' as const, id: o.id } };
      if (s.vendor && s.jobworkRate > 0) {
        jobworkByStage.set(key, [
          ...(jobworkByStage.get(key) ?? []),
          { ...base, value: round(s.jobworkRate), label: s.vendor.name, detail: `${o.number} · ${s.orderLine.product.factoryCode} · outsourced`, unit: 'per piece' },
        ]);
      }
      if (!s.vendor && s.labourRate > 0) {
        labourByStage.set(key, [
          ...(labourByStage.get(key) ?? []),
          { ...base, value: round(s.labourRate), label: `In-house — ${o.number}`, detail: `${s.orderLine.product.factoryCode} · paid to whoever cleared it`, unit: 'per piece' },
        ]);
      }
    }

    // --- assemble one answer per requested line ----------------------------
    const out: (Suggestion & { outlier: ReturnType<typeof outlier> })[] = [];
    for (const l of body.lines) {
      const key = normalizeKey(l.name);
      const groupKey = normalizeKey(l.groupName);
      const stageKey = l.stageStepId != null ? stepNameById.get(l.stageStepId) : undefined;

      const items = [...(itemsByKey.get(groupKey) ?? []), ...(itemsByKey.get(key) ?? [])];
      const purchased = items.flatMap((i) => purchasedByItem.get(i.id) ?? []);

      const sources: (SourceStats | null)[] = [
        summarize('COSTED', 'Costed before', costedByKey.get(key) ?? []),
        summarize('PURCHASED', 'A supplier billed', purchased),
        stageKey ? summarize('JOBWORK', 'Vendors charged for this stage', jobworkByStage.get(stageKey) ?? []) : null,
        stageKey ? summarize('LABOUR', 'In-house piece rate for this stage', labourByStage.get(stageKey) ?? []) : null,
      ];
      const suggestion = assemble(key, l.name, sources);
      out.push({ ...suggestion, outlier: outlier(l.value ?? null, suggestion.primary, setting.outlierPct) });
    }

    res.json({ windowDays: setting.suggestionWindowDays, outlierPct: setting.outlierPct, suggestions: out });
  })
);

// ---------------------------------------------------------------------------
// What this product has sold for
// ---------------------------------------------------------------------------

/**
 * Past prices for a product: this buyer first, then everyone, in one currency.
 *
 * Currencies are never mixed — quoting a euro figure in dollars because it was the
 * most recent would be worse than offering nothing.
 */
router.get(
  '/suggest/price',
  can('suggestions.view'),
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        productId: z.coerce.number().int(),
        buyerId: z.coerce.number().int().optional(),
        currency: z.string().optional(),
        value: z.coerce.number().optional(),
      })
      .parse(req.query);
    const setting = await appSetting();
    const since = windowStart(setting.suggestionWindowDays);
    const code = q.currency?.toUpperCase();

    const [orderLines, proformaLines] = await Promise.all([
      prisma.orderLine.findMany({
        where: { productId: q.productId, order: { status: { not: 'Cancelled' }, deletedAt: null, ...(since ? { orderDate: { gte: since } } : {}) } },
        select: { unitPrice: true, qty: true, order: { select: { id: true, number: true, orderDate: true, buyerId: true, buyer: { select: { name: true } }, currency: { select: { code: true } } } } },
      }),
      prisma.proformaLine.findMany({
        where: { productId: q.productId, proforma: { deletedAt: null, ...(since ? { date: { gte: since } } : {}) } },
        select: { unitPrice: true, qty: true, proforma: { select: { id: true, number: true, date: true, status: true, buyerId: true, buyer: { select: { name: true } }, currency: { select: { code: true } } } } },
      }),
    ]);

    const rows = [
      ...orderLines.map((l) => ({
        value: round(l.unitPrice),
        date: l.order.orderDate,
        buyerId: l.order.buyerId,
        currency: l.order.currency?.code ?? 'INR',
        label: `${l.order.buyer.name} — ${l.order.number}`,
        detail: `order · ${l.qty} pc`,
        qty: l.qty,
        link: { type: 'order' as const, id: l.order.id },
      })),
      ...proformaLines.map((l) => ({
        value: round(l.unitPrice),
        date: l.proforma.date,
        buyerId: l.proforma.buyerId,
        currency: l.proforma.currency?.code ?? 'INR',
        label: `${l.proforma.buyer.name} — ${l.proforma.number}`,
        detail: `proforma (${l.proforma.status.toLowerCase()}) · ${l.qty} pc`,
        qty: l.qty,
        link: { type: 'proforma' as const, id: l.proforma.id },
      })),
    ].filter((r) => (code ? r.currency === code : true));

    const mine = q.buyerId ? rows.filter((r) => r.buyerId === q.buyerId) : [];
    const buyerStats = summarize('BUYER', 'This buyer paid', mine);
    const allStats = summarize('ALL', 'Every buyer', rows);
    const suggestion = assemble(`product-${q.productId}`, `Product #${q.productId}`, [buyerStats, allStats]);

    res.json({
      windowDays: setting.suggestionWindowDays,
      outlierPct: setting.outlierPct,
      currency: code ?? null,
      ...suggestion,
      outlier: outlier(q.value ?? null, suggestion.primary, setting.outlierPct),
    });
  })
);

// ---------------------------------------------------------------------------
// Single rates: jobwork, in-house piece, purchases, wages
// ---------------------------------------------------------------------------

router.get(
  '/suggest/rate',
  can('suggestions.view'),
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        kind: z.enum(['JOBWORK', 'LABOUR', 'PURCHASE', 'WORKER']),
        /** Stage name for JOBWORK / LABOUR. */
        stage: z.string().optional(),
        vendorId: z.coerce.number().int().optional(),
        rawItemId: z.coerce.number().int().optional(),
        supplierId: z.coerce.number().int().optional(),
        tradeId: z.coerce.number().int().optional(),
        payType: z.string().optional(),
        value: z.coerce.number().optional(),
      })
      .parse(req.query);
    const setting = await appSetting();
    const since = windowStart(setting.suggestionWindowDays);

    let sources: (SourceStats | null)[] = [];

    if (q.kind === 'JOBWORK' || q.kind === 'LABOUR') {
      const key = normalizeKey(q.stage);
      const stages = await prisma.orderLineStage.findMany({
        where: { orderLine: { order: { status: { not: 'Cancelled' }, deletedAt: null, ...(since ? { orderDate: { gte: since } } : {}) } } },
        select: {
          name: true,
          jobworkRate: true,
          labourRate: true,
          vendorId: true,
          vendor: { select: { name: true } },
          orderLine: { select: { order: { select: { id: true, number: true, orderDate: true } }, product: { select: { factoryCode: true, name: true } } } },
        },
      });
      const matching = stages.filter((s) => normalizeKey(s.name) === key);
      const asOcc = (s: (typeof matching)[number], value: number, label: string): Occurrence => ({
        value: round(value),
        date: s.orderLine.order.orderDate,
        label,
        detail: `${s.orderLine.order.number} · ${s.orderLine.product.factoryCode}`,
        unit: 'per piece',
        link: { type: 'order', id: s.orderLine.order.id },
      });

      if (q.kind === 'JOBWORK') {
        const mine = q.vendorId ? matching.filter((s) => s.vendorId === q.vendorId && s.jobworkRate > 0) : [];
        sources = [
          summarize('VENDOR', 'This vendor charged', mine.map((s) => asOcc(s, s.jobworkRate, s.vendor?.name ?? 'Vendor'))),
          summarize('ALL_VENDORS', 'Any vendor for this stage', matching.filter((s) => s.vendorId && s.jobworkRate > 0).map((s) => asOcc(s, s.jobworkRate, s.vendor?.name ?? 'Vendor'))),
          summarize('LABOUR', 'Done in-house at', matching.filter((s) => !s.vendorId && s.labourRate > 0).map((s) => asOcc(s, s.labourRate, 'In-house piece rate'))),
        ];
      } else {
        sources = [
          summarize('LABOUR', 'In-house piece rate before', matching.filter((s) => !s.vendorId && s.labourRate > 0).map((s) => asOcc(s, s.labourRate, 'In-house'))),
          summarize('ALL_VENDORS', 'Vendors charged', matching.filter((s) => s.vendorId && s.jobworkRate > 0).map((s) => asOcc(s, s.jobworkRate, s.vendor?.name ?? 'Vendor'))),
        ];
      }
    }

    if (q.kind === 'PURCHASE' && q.rawItemId) {
      const txns = await prisma.stockTxn.findMany({
        where: { type: 'IN', rawItemId: q.rawItemId, ...(since ? { date: { gte: since } } : {}) },
        select: { rate: true, qty: true, date: true, supplierId: true, supplier: { select: { name: true } }, rawItem: { select: { id: true, code: true, unit: true } } },
      });
      const asOcc = (t: (typeof txns)[number]): Occurrence => ({
        value: round(t.rate),
        date: t.date,
        label: t.supplier?.name ?? 'Supplier not recorded',
        detail: `${round(t.qty, 3)} ${t.rawItem.unit}`,
        unit: t.rawItem.unit,
        qty: t.qty,
        link: { type: 'stock', id: t.rawItem.id },
      });
      sources = [
        summarize('SUPPLIER', 'This supplier billed', q.supplierId ? txns.filter((t) => t.supplierId === q.supplierId && t.rate > 0).map(asOcc) : []),
        summarize('ALL_SUPPLIERS', 'Any supplier', txns.filter((t) => t.rate > 0).map(asOcc)),
      ];
      // What the material is costed at in product sheets, for comparison.
      const item = await prisma.rawItem.findUnique({ where: { id: q.rawItemId }, select: { name: true, code: true } });
      if (item) {
        const key = normalizeKey(item.name);
        const lines = await prisma.costLine.findMany({
          where: { group: { costSheet: { isActive: true, product: { deletedAt: null }, ...(since ? { createdAt: { gte: since } } : {}) } } },
          select: { rate: true, unit: true, group: { select: { name: true, costSheet: { select: { createdAt: true, product: { select: { id: true, factoryCode: true, name: true } } } } } } },
        });
        sources.push(
          summarize(
            'COSTED',
            'Costed in products at',
            lines
              .filter((l) => normalizeKey(l.group.name) === key && l.rate > 0)
              .map((l) => ({
                value: round(l.rate),
                date: l.group.costSheet.createdAt,
                label: `${l.group.costSheet.product.factoryCode} — ${l.group.costSheet.product.name}`,
                detail: l.group.name,
                unit: l.unit,
                link: { type: 'product' as const, id: l.group.costSheet.product.id },
              }))
          )
        );
      }
    }

    if (q.kind === 'WORKER') {
      // A worker's rate has no history of its own — what helps is what the trade is
      // actually being paid right now, plus any logged change to a rate.
      const workers = await prisma.worker.findMany({
        where: { isActive: true, ...(q.tradeId ? { tradeId: q.tradeId } : {}), ...(q.payType ? { payType: q.payType } : {}) },
        select: { id: true, code: true, name: true, payType: true, dailyRate: true, monthlySalary: true, otHourlyRate: true, joinedOn: true, trade: { select: { name: true } } },
      });
      const field = q.payType === 'MONTHLY' ? 'monthlySalary' : 'dailyRate';
      sources = [
        summarize(
          'PEERS',
          q.tradeId ? 'Others in this trade are on' : 'Others are on',
          workers
            .map((w) => ({
              value: round(field === 'monthlySalary' ? w.monthlySalary : w.dailyRate),
              date: w.joinedOn,
              label: `${w.code} — ${w.name}`,
              detail: [w.trade?.name, w.payType === 'MONTHLY' ? 'per month' : 'per day', w.otHourlyRate ? `OT ₹${w.otHourlyRate}/h` : null].filter(Boolean).join(' · '),
              link: { type: 'worker' as const, id: w.id },
            }))
            .filter((o) => o.value > 0)
        ),
      ];
    }

    const suggestion = assemble(normalizeKey(q.stage ?? q.kind), q.stage ?? q.kind, sources);
    res.json({ windowDays: setting.suggestionWindowDays, outlierPct: setting.outlierPct, ...suggestion, outlier: outlier(q.value ?? null, suggestion.primary, setting.outlierPct) });
  })
);

// ---------------------------------------------------------------------------
// The change log
// ---------------------------------------------------------------------------

/**
 * What changed on one record, newest first.
 *
 * Suggestions say what a figure has been; this says who moved it and when — the one
 * question the live records cannot answer, because an edit overwrites the old value.
 */
/**
 * Which permission a history read needs depends on WHOSE history it is, so the route asks
 * for any of them and the handler narrows it. `changelog.view` is the superset — it covers
 * every record type, including the ones that have no History tab of their own.
 */
const HISTORY_PERMISSION: Record<string, string> = {
  Product: 'products.history',
  Order: 'orders.history',
  Proforma: 'proformas.view',
  Worker: 'wages.view',
};

router.get(
  '/change-log',
  canAny('changelog.view', 'orders.history', 'products.history', 'proformas.view', 'wages.view'),
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        rootType: z.enum(CHANGE_ROOTS),
        rootId: z.coerce.number().int(),
        take: z.coerce.number().int().min(1).max(500).optional(),
      })
      .parse(req.query);

    // A record type with no entry here (a raw item, a statutory component) is only reachable
    // with the broad permission — the specific ones are the tabs that actually exist.
    const specific = HISTORY_PERMISSION[q.rootType];
    if (!may(req, 'changelog.view') && !(specific && may(req, specific))) {
      throw new ApiError(403, `You do not have permission to see the change history of a ${q.rootType.toLowerCase()}.`);
    }

    res.json(
      await prisma.changeLog.findMany({
        where: { rootType: q.rootType, rootId: q.rootId },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        take: q.take ?? 200,
      })
    );
  })
);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

router.get(
  '/app-settings',
  canAny('masters.view', 'money.view', 'settings.app'),
  asyncHandler(async (_req, res) => {
    res.json(await appSetting());
  })
);

// Only the PUT is restricted: the window and tolerance are needed to RENDER a hint,
// so every signed-in user may read them.
router.put(
  '/app-settings',
  can('masters.view', 'settings.app'),
  asyncHandler(async (req, res) => {
    const data = z
      .object({ suggestionWindowDays: z.number().int().min(0).max(3650).optional(), outlierPct: z.number().min(0).max(1000).optional() })
      .parse(req.body);
    await appSetting();
    res.json(await prisma.appSetting.update({ where: { id: 1 }, data }));
  })
);

export default router;
