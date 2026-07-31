/**
 * Manforce — workers, attendance, wages and statutory dues.
 *
 * Two things shape every route here:
 *
 * 1. NOTHING DERIVABLE IS WRITTEN. There is no wage table and no balance column: the
 *    money comes out of `lib/workforce.ts` on every read, from attendance and the
 *    production board. What IS written is what only a human knows — who was absent,
 *    what rate was agreed, how much cash was handed over.
 *
 * 2. THE FLOOR AND THE MONEY ARE SEPARATE JOBS. An Operator marks the muster and
 *    records who did the work; creating workers, setting rates, paying wages and
 *    posting statutory liability need a Manager. Identity and bank details are only
 *    served to a Manager too — an Operator has no business reading them.
 *
 * Wage PAYMENTS are not here: they go through `POST /payments` with a WORKER,
 * CONTRACTOR or STATUTORY party type, so all money movement stays in one ledger.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { ApiError, asyncHandler, guardIdParams } from '../lib/http';
import { authenticate, can, canAny, may } from '../middleware/auth';
import { imageUploader, keepRealImages, uploadDir } from '../lib/imageUpload';
import { nextDocNumber } from '../lib/numbering';
import { round } from '../lib/costing';
import { like } from '../lib/search';
import { buildWorkforceContext, ensureSettings, loadRules, statutoryPreview, workerStatement, workforceTotals, workerSelect } from '../lib/manforce';
import { diffFields, logChanges } from '../lib/changeLog';
import { trashedNote } from '../lib/references';
import {
  ATTENDANCE_STATUSES,
  MONTHLY_DIVISORS,
  PAY_TYPES,
  STATUTORY_BASES,
  attendanceEarnings,
  dayKey,
  dayStart,
  eachDay,
  isWorkingDay,
  monthKey,
  parseWeeklyOffDays,
} from '../lib/workforce';

const router = Router();
// A route param here is always a database id — see guardIdParams.
guardIdParams(router);
router.use(authenticate);

/** Worker photos and ID scans share the uploads folder, named so they stand out. */
const uploadDocs = imageUploader('worker-');

/** Identity and payout details, withheld unless the caller holds `workers.pii`. */
const SENSITIVE = ['aadhaarNo', 'panNo', 'uanNo', 'esicNo', 'bankName', 'bankAccountNo', 'bankIfsc', 'upiId'] as const;

function redact<T extends Record<string, any>>(worker: T, manager: boolean): T {
  if (manager) return worker;
  const copy = { ...worker };
  for (const key of SENSITIVE) if (key in copy) (copy as any)[key] = null;
  return copy;
}

// ---------------------------------------------------------------------------
// Configuration — trades, contractors, working days, statutory components
// ---------------------------------------------------------------------------

router.get(
  '/trades',
  canAny('masters.view', 'workers.view'),
  asyncHandler(async (_req, res) => {
    const trades = await prisma.trade.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], include: { _count: { select: { workers: true } } } });
    res.json(trades.map((t) => ({ id: t.id, name: t.name, isActive: t.isActive, sortOrder: t.sortOrder, workers: t._count.workers })));
  })
);

const tradeSchema = z.object({ name: z.string().min(1), isActive: z.boolean().optional(), sortOrder: z.number().int().optional() });

router.post(
  '/trades',
  can('masters.view', 'trades.manage'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await prisma.trade.create({ data: tradeSchema.parse(req.body) }));
  })
);

router.patch(
  '/trades/:id',
  can('masters.view', 'trades.manage'),
  asyncHandler(async (req, res) => {
    res.json(await prisma.trade.update({ where: { id: Number(req.params.id) }, data: tradeSchema.partial().parse(req.body) }));
  })
);

router.delete(
  '/trades/:id',
  can('masters.view', 'trades.manage'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const trade = await prisma.trade.findUnique({ where: { id }, include: { _count: { select: { workers: true } } } });
    if (!trade) throw new ApiError(404, 'Trade not found.');
    if (trade._count.workers > 0) throw new ApiError(409, `${trade.name} is the trade of ${trade._count.workers} worker(s). Deactivate it instead of deleting.`);
    await prisma.trade.delete({ where: { id } });
    res.status(204).end();
  })
);

router.get(
  '/contractors',
  can('workers.view'),
  asyncHandler(async (_req, res) => {
    const rows = await prisma.contractor.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { workers: true } } } });
    res.json(rows.map((c) => ({ ...c, workers: c._count.workers, _count: undefined })));
  })
);

const contractorSchema = z.object({
  code: z.string().min(1).optional(),
  name: z.string().min(1),
  contactName: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().email().or(z.literal('')).nullable().optional(),
  gstNo: z.string().nullable().optional(),
  panNo: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  paymentTerms: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  notes: z.string().nullable().optional(),
});

router.post(
  '/contractors',
  can('workers.view', 'contractors.manage'),
  asyncHandler(async (req, res) => {
    const data = contractorSchema.parse(req.body);
    const code = data.code?.trim() ? data.code.trim().toUpperCase() : await nextDocNumber('CTR');
    res.status(201).json(await prisma.contractor.create({ data: { ...data, code } }));
  })
);

router.patch(
  '/contractors/:id',
  can('workers.view', 'contractors.manage'),
  asyncHandler(async (req, res) => {
    const data = contractorSchema.partial().parse(req.body);
    res.json(await prisma.contractor.update({ where: { id: Number(req.params.id) }, data: { ...data, ...(data.code ? { code: data.code.toUpperCase() } : {}) } }));
  })
);

router.delete(
  '/contractors/:id',
  can('workers.view', 'contractors.manage'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const contractor = await prisma.contractor.findUnique({ where: { id } });
    if (!contractor) throw new ApiError(404, 'Contractor not found.');
    const [workers, ledger] = await Promise.all([prisma.worker.count({ where: { contractorId: id } }), prisma.ledgerEntry.count({ where: { contractorId: id } })]);
    if (workers + ledger > 0) {
      const bits = [workers && `${workers} worker(s)`, ledger && `${ledger} money entry/entries`].filter(Boolean).join(' and ');
      throw new ApiError(409, `${contractor.name} still has ${bits}.${await trashedNote([{ model: 'ledgerEntry', where: { contractorId: id } }])} Deactivate them instead of deleting.`);
    }
    await prisma.contractor.delete({ where: { id } });
    res.status(204).end();
  })
);

// --- working days -----------------------------------------------------------

router.get(
  '/workforce/settings',
  canAny('masters.view', 'workers.view'),
  asyncHandler(async (_req, res) => {
    const setting = await ensureSettings();
    const holidays = await prisma.holiday.findMany({ orderBy: { date: 'asc' } });
    res.json({ ...setting, weeklyOffDayList: parseWeeklyOffDays(setting.weeklyOffDays), holidays });
  })
);

const settingsSchema = z.object({
  weeklyOffDays: z.array(z.number().int().min(0).max(6)).optional(),
  presumePresent: z.boolean().optional(),
  shiftHours: z.number().positive().optional(),
  otMultiplier: z.number().min(0).optional(),
  halfDayFactor: z.number().min(0).max(1).optional(),
  monthlyDivisor: z.enum(MONTHLY_DIVISORS).optional(),
  defaultAdvanceRecovery: z.number().min(0).optional(),
});

router.put(
  '/workforce/settings',
  can('masters.view', 'workforce.settings'),
  asyncHandler(async (req, res) => {
    const { weeklyOffDays, ...data } = settingsSchema.parse(req.body);
    await ensureSettings();
    const updated = await prisma.workforceSetting.update({
      where: { id: 1 },
      data: { ...data, ...(weeklyOffDays ? { weeklyOffDays: [...new Set(weeklyOffDays)].sort((a, b) => a - b).join(',') } : {}) },
    });
    // Same shape as the GET, holidays included — the client declares them as always
    // present, and a caller that trusted the response would read back none.
    const holidays = await prisma.holiday.findMany({ orderBy: { date: 'asc' } });
    res.json({ ...updated, weeklyOffDayList: parseWeeklyOffDays(updated.weeklyOffDays), holidays });
  })
);

router.post(
  '/holidays',
  can('masters.view', 'holidays.manage'),
  asyncHandler(async (req, res) => {
    const data = z.object({ date: z.string(), name: z.string().min(1) }).parse(req.body);
    const date = dayStart(data.date);
    res.status(201).json(await prisma.holiday.upsert({ where: { date }, update: { name: data.name }, create: { date, name: data.name } }));
  })
);

router.delete(
  '/holidays/:id',
  can('masters.view', 'holidays.manage'),
  asyncHandler(async (req, res) => {
    await prisma.holiday.delete({ where: { id: Number(req.params.id) } });
    res.status(204).end();
  })
);

// --- statutory components ---------------------------------------------------

router.get(
  '/statutory-components',
  canAny('masters.view', 'statutory.view'),
  asyncHandler(async (_req, res) => {
    const rows = await prisma.statutoryComponent.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], include: { _count: { select: { coverage: true, lines: true } } } });
    res.json(rows.map((c) => ({ ...c, covered: c._count.coverage, postedLines: c._count.lines, _count: undefined })));
  })
);

const componentSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  employeePct: z.number().min(0).max(100).optional(),
  employerPct: z.number().min(0).max(100).optional(),
  flatAmount: z.number().min(0).optional(),
  basis: z.enum(STATUTORY_BASES).optional(),
  wageCeiling: z.number().min(0).nullable().optional(),
  eligibilityCeiling: z.number().min(0).nullable().optional(),
  minWages: z.number().min(0).nullable().optional(),
  payeeName: z.string().optional(),
  isProvision: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  notes: z.string().nullable().optional(),
});

router.post(
  '/statutory-components',
  can('masters.view', 'statutory.components.manage'),
  asyncHandler(async (req, res) => {
    const data = componentSchema.parse(req.body);
    res.status(201).json(await prisma.statutoryComponent.create({ data: { ...data, code: data.code.toUpperCase() } }));
  })
);

router.patch(
  '/statutory-components/:id',
  can('masters.view', 'statutory.components.manage'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const data = componentSchema.partial().parse(req.body);
    const existing = await prisma.statutoryComponent.findUnique({ where: { id } });
    if (!existing) throw new ApiError(404, 'Component not found.');

    // A levy's percentages decide what everyone is deducted, so a change is logged.
    // Postings already made keep their own stored figures and are unaffected.
    await logChanges(
      prisma,
      { type: 'StatutoryComponent', id },
      { id: req.user!.sub, name: req.user!.name },
      diffFields('StatutoryComponent', id, existing, data, [
        { field: 'employeePct', label: 'employee %' },
        { field: 'employerPct', label: 'employer %' },
        { field: 'flatAmount', label: 'flat amount' },
        { field: 'basis', label: 'computed on' },
        { field: 'wageCeiling', label: 'contribution ceiling' },
        { field: 'eligibilityCeiling', label: 'eligibility ceiling' },
        { field: 'minWages', label: 'applies from' },
        { field: 'isProvision', label: 'provision only' },
        { field: 'isActive', label: 'active' },
      ])
    );

    res.json(await prisma.statutoryComponent.update({ where: { id }, data: { ...data, ...(data.code ? { code: data.code.toUpperCase() } : {}) } }));
  })
);

router.delete(
  '/statutory-components/:id',
  can('masters.view', 'statutory.components.manage'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const component = await prisma.statutoryComponent.findUnique({ where: { id }, include: { _count: { select: { lines: true, ledger: true } } } });
    if (!component) throw new ApiError(404, 'Component not found.');
    if (component._count.lines + component._count.ledger > 0) {
      const bits = [component._count.lines && `${component._count.lines} posted line(s)`, component._count.ledger && `${component._count.ledger} payment(s)`].filter(Boolean).join(' and ');
      throw new ApiError(409, `${component.code} has ${bits} against it. Deactivate it instead of deleting.`);
    }
    await prisma.statutoryComponent.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

router.get(
  '/workers',
  can('workers.view'),
  asyncHandler(async (req, res) => {
    const q = (req.query.q as string | undefined)?.trim();
    const where: any = {};
    if (req.query.active === '1') where.isActive = true;
    if (req.query.contractorId) where.contractorId = Number(req.query.contractorId);
    if (req.query.tradeId) where.tradeId = Number(req.query.tradeId);
    if (req.query.payType) where.payType = req.query.payType;
    if (q) where.OR = [{ name: like(q) }, { code: like(q) }, { phone: like(q) }];

    const workers = await prisma.worker.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: { trade: { select: { id: true, name: true } }, contractor: { select: { id: true, name: true, code: true } }, documents: { where: { kind: 'PHOTO' }, orderBy: { sortOrder: 'asc' }, take: 1 } },
    });

    // The money is a derived figure, so asking for it costs a full pass over
    // attendance and the board — only do it when the caller wants it AND may see it.
    const wanted = req.query.money === '1' && may(req, 'wages.view');
    const ctx = wanted ? await buildWorkforceContext() : null;

    res.json(
      workers.map((w) => {
        const position = ctx?.accounts.get(w.id)?.position;
        return {
          ...redact(w, may(req, 'workers.pii')),
          documents: undefined,
          photoUrl: w.documents[0]?.url ?? null,
          money: position
            ? { earned: position.earned, paid: position.paid, advanced: position.advanced, dueNow: position.dueNow, balance: position.balance, advanceOutstanding: position.advanceOutstanding, days: position.earnedDays, pieces: position.earnedPieces }
            : null,
        };
      })
    );
  })
);

router.get(
  '/workers/:id',
  can('workers.view'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const worker = await prisma.worker.findUnique({
      where: { id },
      include: {
        trade: { select: { id: true, name: true } },
        contractor: { select: { id: true, name: true, code: true } },
        documents: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
        statutory: { include: { component: { select: { id: true, code: true, name: true } } } },
      },
    });
    if (!worker) throw new ApiError(404, 'Worker not found.');

    const identity = {
      ...redact(worker, may(req, 'workers.pii')),
      photoUrl: worker.documents.find((d) => d.kind === 'PHOTO')?.url ?? null,
    };

    // Everything below this line is money — what the worker earned, was paid, owes and is
    // owed. Withheld whole rather than zeroed, so the page can say "you cannot see wages"
    // instead of showing a balance of nothing and being believed.
    if (!may(req, 'wages.view')) {
      res.json({ ...identity, wagesHidden: true, position: null, earnings: [], deductions: [], advances: [], payments: [], statutoryPosted: [], statement: [] });
      return;
    }

    const ctx = await buildWorkforceContext();
    const account = ctx.accounts.get(id)!;

    res.json({
      ...identity,
      position: account.position,
      earnings: account.earnings.slice(-400).reverse(),
      deductions: account.deductions,
      advances: account.advances.map((a) => {
        const state = account.position.advanceStates.find((s) => s.advanceId === a.id);
        return { ...a, recovered: state?.recovered ?? 0, outstanding: state?.outstanding ?? a.amount };
      }),
      payments: account.payments,
      statutoryPosted: account.statutory,
      statement: workerStatement(account),
    });
  })
);

const workerSchema = z.object({
  code: z.string().min(1).optional(),
  name: z.string().min(1),
  tradeId: z.number().int().nullable().optional(),
  contractorId: z.number().int().nullable().optional(),
  payType: z.enum(PAY_TYPES).optional(),
  dailyRate: z.number().min(0).optional(),
  otHourlyRate: z.number().min(0).optional(),
  monthlySalary: z.number().min(0).optional(),
  joinedOn: z.string().optional(),
  exitOn: z.string().nullable().optional(),
  exitReason: z.string().nullable().optional(),
  accrualFrom: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  phone: z.string().nullable().optional(),
  altPhone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  guardianName: z.string().nullable().optional(),
  emergencyName: z.string().nullable().optional(),
  emergencyPhone: z.string().nullable().optional(),
  dateOfBirth: z.string().nullable().optional(),
  gender: z.string().nullable().optional(),
  aadhaarNo: z.string().nullable().optional(),
  panNo: z.string().nullable().optional(),
  uanNo: z.string().nullable().optional(),
  esicNo: z.string().nullable().optional(),
  bankName: z.string().nullable().optional(),
  bankAccountNo: z.string().nullable().optional(),
  bankIfsc: z.string().nullable().optional(),
  upiId: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  /** Which statutory components cover this worker. */
  statutoryComponentIds: z.array(z.number().int()).optional(),
});

const asDate = (v: string | null | undefined) => (v == null || v === '' ? null : new Date(v));

/** A pay type is only meaningful with the rate that goes with it. */
/**
 * What a worker IS and what a worker is PAID are separate permissions, so which one a save
 * needs depends on whether a rate is in the payload. Checked in the handler rather than as
 * middleware for that reason — one route serves both kinds of edit.
 *
 * The pay TYPE counts as a rate: moving somebody from a day rate to piece work changes what
 * they earn as surely as changing the number does.
 */
function guardRates(
  req: Parameters<typeof may>[0],
  d: { payType?: string; dailyRate?: number; otHourlyRate?: number; monthlySalary?: number }
): void {
  const touches = d.payType !== undefined || d.dailyRate !== undefined || d.otHourlyRate !== undefined || d.monthlySalary !== undefined;
  if (!touches || may(req, 'workers.rates')) return;
  throw new ApiError(403, 'You do not have permission to do this. Setting a pay type or rate needs "Set worker pay rates".');
}

function checkRates(payType: string | undefined, data: { dailyRate?: number; monthlySalary?: number }, existing?: { dailyRate: number; monthlySalary: number }) {
  const daily = data.dailyRate ?? existing?.dailyRate ?? 0;
  const monthly = data.monthlySalary ?? existing?.monthlySalary ?? 0;
  if (payType === 'DAY' && daily <= 0) throw new ApiError(400, 'A day-wage worker needs a daily rate, or nothing will ever accrue for them.');
  if (payType === 'MONTHLY' && monthly <= 0) throw new ApiError(400, 'A salaried worker needs a monthly salary, or nothing will ever accrue for them.');
}

async function applyCoverage(workerId: number, componentIds: number[] | undefined) {
  if (!componentIds) return;
  await prisma.workerStatutory.deleteMany({ where: { workerId, componentId: { notIn: componentIds.length ? componentIds : [-1] } } });
  for (const componentId of componentIds) {
    await prisma.workerStatutory.upsert({ where: { workerId_componentId: { workerId, componentId } }, update: { covered: true }, create: { workerId, componentId, covered: true } });
  }
}

router.post(
  '/workers',
  can('workers.view', 'workers.manage'),
  asyncHandler(async (req, res) => {
    const { statutoryComponentIds, ...data } = workerSchema.parse(req.body);
    guardRates(req, data);
    checkRates(data.payType ?? 'DAY', data);
    if (data.contractorId && !(await prisma.contractor.findUnique({ where: { id: data.contractorId } }))) throw new ApiError(404, 'Contractor not found.');

    const code = data.code?.trim() ? data.code.trim().toUpperCase() : await nextDocNumber('WRK');
    const worker = await prisma.worker.create({
      data: {
        ...data,
        code,
        joinedOn: asDate(data.joinedOn) ?? new Date(),
        exitOn: asDate(data.exitOn),
        dateOfBirth: asDate(data.dateOfBirth),
        // A new worker starts accruing the day they joined; there is no history to
        // avoid overlapping.
        accrualFrom: asDate(data.accrualFrom),
        createdById: req.user!.sub,
      },
    });
    await applyCoverage(worker.id, statutoryComponentIds);
    res.status(201).json(worker);
  })
);

router.patch(
  '/workers/:id',
  can('workers.view', 'workers.manage'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.worker.findUnique({ where: { id } });
    if (!existing) throw new ApiError(404, 'Worker not found.');
    const { statutoryComponentIds, ...data } = workerSchema.partial().parse(req.body);
    guardRates(req, data);
    checkRates(data.payType ?? existing.payType, data, existing);

    // Moving a worker into or out of a gang changes who gets paid, so it cannot be
    // done while money is still sitting against them personally.
    if (data.contractorId !== undefined && data.contractorId !== existing.contractorId) {
      const paid = await prisma.ledgerEntry.count({ where: { workerId: id, partyType: 'WORKER' } });
      if (paid > 0) throw new ApiError(409, `${existing.name} already has ${paid} payment(s) recorded against them personally. Settle those first, or keep them where they are.`);
    }

    // What someone is paid is the figure most worth a record of who changed it.
    await logChanges(
      prisma,
      { type: 'Worker', id },
      { id: req.user!.sub, name: req.user!.name },
      // Only the pay fields — dates and contact details are not money.
      diffFields(
        'Worker',
        id,
        existing,
        {
          ...(data.payType !== undefined ? { payType: data.payType } : {}),
          ...(data.dailyRate !== undefined ? { dailyRate: data.dailyRate } : {}),
          ...(data.otHourlyRate !== undefined ? { otHourlyRate: data.otHourlyRate } : {}),
          ...(data.monthlySalary !== undefined ? { monthlySalary: data.monthlySalary } : {}),
          ...(data.contractorId !== undefined ? { contractorId: data.contractorId } : {}),
        },
        [
          { field: 'payType', label: 'pay type' },
          { field: 'dailyRate', label: 'daily rate' },
          { field: 'otHourlyRate', label: 'overtime rate' },
          { field: 'monthlySalary', label: 'monthly salary' },
          { field: 'contractorId', label: 'paid through (contractor id)' },
        ]
      )
    );

    const worker = await prisma.worker.update({
      where: { id },
      data: {
        ...data,
        ...(data.joinedOn !== undefined ? { joinedOn: asDate(data.joinedOn) ?? existing.joinedOn } : {}),
        ...(data.exitOn !== undefined ? { exitOn: asDate(data.exitOn) } : {}),
        ...(data.dateOfBirth !== undefined ? { dateOfBirth: asDate(data.dateOfBirth) } : {}),
        ...(data.accrualFrom !== undefined ? { accrualFrom: asDate(data.accrualFrom) } : {}),
        ...(data.code ? { code: data.code.toUpperCase() } : {}),
      },
    });
    await applyCoverage(id, statutoryComponentIds);
    res.json(worker);
  })
);

router.delete(
  '/workers/:id',
  can('workers.view', 'workers.manage'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const worker = await prisma.worker.findUnique({ where: { id } });
    if (!worker) throw new ApiError(404, 'Worker not found.');
    const [moves, ledger, advances, posted, attendance] = await Promise.all([
      prisma.stageMoveWorker.count({ where: { workerId: id } }),
      prisma.ledgerEntry.count({ where: { workerId: id } }),
      prisma.workerAdvance.count({ where: { workerId: id } }),
      prisma.statutoryPostingLine.count({ where: { workerId: id } }),
      prisma.attendance.count({ where: { workerId: id } }),
    ]);
    if (moves + ledger + advances + posted > 0) {
      const bits = [moves && `${moves} piece movement(s)`, ledger && `${ledger} money entry/entries`, advances && `${advances} advance(s)`, posted && `${posted} statutory posting line(s)`].filter(Boolean).join(', ');
      throw new ApiError(409, `${worker.name} is referenced by ${bits}.${await trashedNote([{ model: 'ledgerEntry', where: { workerId: id } }])} Mark them as having left instead of deleting them.`);
    }
    // Attendance and photos are the worker's own records and go with them.
    const documents = await prisma.workerDocument.findMany({ where: { workerId: id } });
    await prisma.worker.delete({ where: { id } });
    for (const d of documents) fs.promises.unlink(path.join(uploadDir, d.filename)).catch(() => undefined);
    res.status(204).end();
  })
);

// --- photos and ID scans ----------------------------------------------------

router.post(
  '/workers/:id/documents',
  can('workers.view', 'workers.documents'),
  uploadDocs.array('files', 10),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const worker = await prisma.worker.findUnique({ where: { id }, include: { documents: true } });
    if (!worker) throw new ApiError(404, 'Worker not found.');
    const kind = req.body.kind === 'ID' ? 'ID' : 'PHOTO';
    const files = keepRealImages((req.files as Express.Multer.File[]) ?? []);

    let order = worker.documents.filter((d) => d.kind === kind).length;
    const created = await prisma.$transaction(
      files.map((f) =>
        prisma.workerDocument.create({
          data: { workerId: id, kind, label: req.body.label || null, filename: f.filename, originalName: f.originalname, url: `/uploads/${f.filename}`, sortOrder: order++ },
        })
      )
    );
    res.status(201).json(created);
  })
);

router.delete(
  '/worker-documents/:id',
  can('workers.view', 'workers.documents'),
  asyncHandler(async (req, res) => {
    const doc = await prisma.workerDocument.findUnique({ where: { id: Number(req.params.id) } });
    if (!doc) throw new ApiError(404, 'Document not found.');
    await prisma.workerDocument.delete({ where: { id: doc.id } });
    fs.promises.unlink(path.join(uploadDir, doc.filename)).catch(() => undefined);
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// The muster roll
//
// Attendance is exceptions-only, so this returns the PRESUMPTION for every worker
// alongside whatever has been recorded. The client shows the presumption as the
// current state, which is why marking nobody is a valid full day's attendance.
// ---------------------------------------------------------------------------

router.get(
  '/attendance',
  can('workers.view', 'muster.view'),
  asyncHandler(async (req, res) => {
    const date = dayStart((req.query.date as string) || new Date());
    const { rules, holidays } = await loadRules();
    const working = isWorkingDay(date, rules, holidays);

    const workers = await prisma.worker.findMany({
      where: { isActive: true, joinedOn: { lte: date }, OR: [{ exitOn: null }, { exitOn: { gte: date } }] },
      include: { trade: { select: { name: true } }, contractor: { select: { id: true, name: true } } },
      orderBy: [{ name: 'asc' }],
    });
    const rows = await prisma.attendance.findMany({ where: { date } });
    const holiday = (await prisma.holiday.findUnique({ where: { date } }))?.name ?? null;

    res.json({
      date,
      isWorkingDay: working,
      holiday,
      weeklyOff: rules.weeklyOffDays.includes(date.getDay()),
      presumePresent: rules.presumePresent,
      workers: workers.map((w) => {
        const row = rows.find((r) => r.workerId === w.id);
        return {
          workerId: w.id,
          code: w.code,
          name: w.name,
          trade: w.trade?.name ?? null,
          contractorId: w.contractorId,
          contractor: w.contractor?.name ?? null,
          payType: w.payType,
          // A piece-rate worker's pay comes off the board, so the muster is only a
          // record of presence for them — never money.
          paysByAttendance: w.payType !== 'PIECE',
          status: row?.status ?? null,
          otHours: row?.otHours ?? 0,
          note: row?.note ?? null,
          attendanceId: row?.id ?? null,
          presumed: row ? null : working && rules.presumePresent ? 'PRESENT' : 'ABSENT',
        };
      }),
    });
  })
);

const musterSchema = z.object({
  date: z.string(),
  marks: z.array(
    z.object({
      workerId: z.number().int(),
      /** null clears the exception and returns the worker to the presumption. */
      status: z.enum(ATTENDANCE_STATUSES).nullable(),
      otHours: z.number().min(0).max(24).optional(),
      note: z.string().nullable().optional(),
    })
  ),
});

router.post(
  '/attendance',
  can('workers.view', 'muster.view', 'muster.mark'),
  asyncHandler(async (req, res) => {
    const data = musterSchema.parse(req.body);
    const date = dayStart(data.date);
    if (date.getTime() > dayStart(new Date()).getTime()) throw new ApiError(400, 'Attendance cannot be marked for a day that has not happened yet.');

    const ids = data.marks.map((m) => m.workerId);
    const workers = await prisma.worker.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, joinedOn: true, exitOn: true } });
    for (const m of data.marks) {
      const w = workers.find((x) => x.id === m.workerId);
      if (!w) throw new ApiError(404, `Worker #${m.workerId} not found.`);
      if (dayStart(w.joinedOn).getTime() > date.getTime()) throw new ApiError(400, `${w.name} had not joined on that date.`);
      if (w.exitOn && dayStart(w.exitOn).getTime() < date.getTime()) throw new ApiError(400, `${w.name} had already left by that date.`);
    }

    await prisma.$transaction(async (tx) => {
      for (const m of data.marks) {
        // Nothing to record: no exception and no overtime is the presumption itself.
        if (m.status == null && !(m.otHours && m.otHours > 0)) {
          await tx.attendance.deleteMany({ where: { workerId: m.workerId, date } });
          continue;
        }
        await tx.attendance.upsert({
          where: { workerId_date: { workerId: m.workerId, date } },
          update: { status: m.status ?? 'PRESENT', otHours: m.otHours ?? 0, note: m.note ?? null, createdById: req.user!.sub },
          create: { workerId: m.workerId, date, status: m.status ?? 'PRESENT', otHours: m.otHours ?? 0, note: m.note ?? null, createdById: req.user!.sub },
        });
      }
    });

    res.json({ date, marked: data.marks.length });
  })
);

/** One worker's month, day by day, with what each day is worth. */
router.get(
  '/attendance/worker/:id',
  can('workers.view', 'muster.view'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const worker = await prisma.worker.findUnique({ where: { id }, select: workerSelect });
    if (!worker) throw new ApiError(404, 'Worker not found.');

    const month = (req.query.month as string) || monthKey(new Date());
    const [y, m] = month.split('-').map(Number);
    const from = new Date(y, m - 1, 1);
    const to = new Date(y, m, 0);

    const { rules, holidays } = await loadRules();
    const rows = await prisma.attendance.findMany({ where: { workerId: id, date: { gte: from, lte: to } } });
    const holidayRows = await prisma.holiday.findMany({ where: { date: { gte: from, lte: to } } });
    const earnings = attendanceEarnings(worker, rows, from, to, rules, holidays);

    res.json({
      month,
      worker: { id: worker.id, code: worker.code, name: worker.name, payType: worker.payType, dailyRate: worker.dailyRate, monthlySalary: worker.monthlySalary },
      days: eachDay(from, to).map((d) => {
        const key = dayKey(d);
        const row = rows.find((r) => dayKey(r.date) === key);
        const dayEarnings = earnings.filter((e) => dayKey(e.date) === key);
        return {
          date: d,
          isWorkingDay: isWorkingDay(d, rules, holidays),
          holiday: holidayRows.find((h) => dayKey(h.date) === key)?.name ?? null,
          status: row?.status ?? null,
          otHours: row?.otHours ?? 0,
          note: row?.note ?? null,
          amount: round(dayEarnings.reduce((a, e) => a + e.amount, 0)),
          days: round(dayEarnings.reduce((a, e) => a + e.days, 0)),
        };
      }),
      earned: round(earnings.reduce((a, e) => a + e.amount, 0)),
      daysPaid: round(earnings.reduce((a, e) => a + e.days, 0)),
      otHours: round(earnings.filter((e) => e.kind === 'OT').reduce((a, e) => a + e.hours, 0)),
    });
  })
);

// ---------------------------------------------------------------------------
// Advances and deductions
// ---------------------------------------------------------------------------

/**
 * Hand over an advance.
 *
 * The cash is a ledger PAYMENT like any other; this record only carries the recovery
 * terms. Both are written in one transaction so an advance can never exist without
 * the money having left, or the other way round.
 */
router.post(
  '/workers/:id/advances',
  can('workers.view', 'wages.view', 'advances.manage'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const worker = await prisma.worker.findUnique({ where: { id } });
    if (!worker) throw new ApiError(404, 'Worker not found.');
    const data = z
      .object({
        amount: z.number().positive(),
        date: z.string().optional(),
        recoveryPerMonth: z.number().min(0).optional(),
        ref: z.string().nullable().optional(),
        note: z.string().nullable().optional(),
      })
      .parse(req.body);

    const { defaultAdvanceRecovery } = await loadRules();
    const recoveryPerMonth = data.recoveryPerMonth ?? defaultAdvanceRecovery;
    if (recoveryPerMonth > data.amount) throw new ApiError(400, 'The monthly recovery cannot be more than the advance itself.');
    const date = data.date ? new Date(data.date) : new Date();

    const advance = await prisma.$transaction(async (tx) => {
      const created = await tx.workerAdvance.create({
        data: { workerId: id, amount: data.amount, date, recoveryPerMonth, ref: data.ref ?? null, note: data.note ?? null, createdById: req.user!.sub },
      });
      await tx.ledgerEntry.create({
        data: {
          partyType: 'WORKER',
          workerId: id,
          contractorId: worker.contractorId,
          partyName: worker.name,
          kind: 'PAYMENT',
          amount: data.amount,
          currency: 'INR',
          date,
          ref: data.ref ?? null,
          note: data.note ?? 'Advance',
          advanceId: created.id,
          createdById: req.user!.sub,
        },
      });
      return created;
    });

    res.status(201).json(advance);
  })
);

router.delete(
  '/advances/:id',
  can('workers.view', 'wages.view', 'advances.manage'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const advance = await prisma.workerAdvance.findUnique({ where: { id } });
    if (!advance) throw new ApiError(404, 'Advance not found.');
    await prisma.$transaction(async (tx) => {
      await tx.ledgerEntry.deleteMany({ where: { advanceId: id } });
      await tx.workerAdvance.delete({ where: { id } });
    });
    res.status(204).end();
  })
);

router.post(
  '/workers/:id/deductions',
  can('workers.view', 'wages.view', 'deductions.manage'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!(await prisma.worker.findUnique({ where: { id } }))) throw new ApiError(404, 'Worker not found.');
    const data = z
      .object({ amount: z.number().positive(), reason: z.string().min(1), date: z.string().optional(), note: z.string().nullable().optional() })
      .parse(req.body);
    res.status(201).json(
      await prisma.workerDeduction.create({
        data: { workerId: id, amount: data.amount, reason: data.reason, date: data.date ? new Date(data.date) : new Date(), note: data.note ?? null, createdById: req.user!.sub },
      })
    );
  })
);

router.delete(
  '/deductions/:id',
  can('workers.view', 'wages.view', 'deductions.manage'),
  asyncHandler(async (req, res) => {
    await prisma.workerDeduction.delete({ where: { id: Number(req.params.id) } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// Statutory liability — incurred only when someone posts it
// ---------------------------------------------------------------------------

const periodSchema = z.object({ from: z.string(), to: z.string(), componentIds: z.union([z.string(), z.array(z.coerce.number().int())]).optional() });

const parseIds = (v: string | number[] | undefined) => (v == null ? undefined : Array.isArray(v) ? v : v.split(',').map(Number).filter(Number.isFinite));

router.get(
  '/statutory/preview',
  can('workers.view', 'statutory.view'),
  asyncHandler(async (req, res) => {
    const q = periodSchema.parse(req.query);
    const from = dayStart(q.from);
    const to = dayStart(q.to);
    if (to.getTime() < from.getTime()) throw new ApiError(400, 'The period ends before it starts.');
    const { lines, components } = await statutoryPreview(from, to, parseIds(q.componentIds));
    res.json({
      from,
      to,
      components: components.map((c) => ({ id: c.id, code: c.code, name: c.name, isProvision: !!c.isProvision })),
      lines,
      totals: components.map((c) => {
        const mine = lines.filter((l) => l.componentId === c.id && l.covered && !l.alreadyPosted);
        return {
          componentId: c.id,
          code: c.code,
          workers: mine.length,
          employee: round(mine.reduce((a, l) => a + l.employeeAmt, 0)),
          employer: round(mine.reduce((a, l) => a + l.employerAmt, 0)),
        };
      }),
    });
  })
);

router.get(
  '/statutory/postings',
  can('workers.view', 'statutory.view'),
  asyncHandler(async (_req, res) => {
    const rows = await prisma.statutoryPosting.findMany({ orderBy: [{ periodFrom: 'desc' }, { id: 'desc' }], include: { lines: { include: { component: { select: { code: true } } } } } });
    res.json(
      rows.map((p) => ({
        id: p.id,
        number: p.number,
        periodFrom: p.periodFrom,
        periodTo: p.periodTo,
        postedOn: p.postedOn,
        note: p.note,
        workers: new Set(p.lines.map((l) => l.workerId)).size,
        components: [...new Set(p.lines.map((l) => l.component.code))],
        employee: round(p.lines.reduce((a, l) => a + l.employeeAmt, 0)),
        employer: round(p.lines.reduce((a, l) => a + l.employerAmt, 0)),
        total: round(p.lines.reduce((a, l) => a + l.employeeAmt + l.employerAmt, 0)),
      }))
    );
  })
);

/**
 * Post the liability for a period.
 *
 * Overlapping periods for the same component are refused: two postings covering the
 * same wages would charge the worker twice and owe the authority double. The wage base
 * used is stored on the line, because the earnings behind it can legitimately be
 * restated later (a holiday added, a rate fixed) and a posted liability must not move.
 */
router.post(
  '/statutory/postings',
  can('workers.view', 'statutory.view', 'statutory.post'),
  asyncHandler(async (req, res) => {
    const data = z
      .object({
        from: z.string(),
        to: z.string(),
        componentIds: z.array(z.number().int()).min(1),
        /** Leave empty to post everyone who is covered and has wages. */
        workerIds: z.array(z.number().int()).optional(),
        note: z.string().nullable().optional(),
      })
      .parse(req.body);

    const from = dayStart(data.from);
    const to = dayStart(data.to);
    if (to.getTime() < from.getTime()) throw new ApiError(400, 'The period ends before it starts.');

    const clashes = await prisma.statutoryPostingLine.findMany({
      where: { componentId: { in: data.componentIds }, posting: { periodFrom: { lte: to }, periodTo: { gte: from } } },
      include: { component: { select: { code: true } }, posting: { select: { number: true } } },
      take: 1,
    });
    if (clashes.length) {
      throw new ApiError(409, `${clashes[0].component.code} is already posted for part of this period by ${clashes[0].posting.number}. Pick a period that does not overlap.`);
    }

    const { lines } = await statutoryPreview(from, to, data.componentIds);
    const wanted = lines.filter((l) => l.covered && !l.alreadyPosted && (l.employeeAmt > 0 || l.employerAmt > 0) && (!data.workerIds?.length || data.workerIds.includes(l.workerId)));
    if (wanted.length === 0) throw new ApiError(400, 'Nothing to post: no covered worker earned wages in that period.');

    const posting = await prisma.$transaction(async (tx) => {
      const number = await nextDocNumber('STP', tx);
      return tx.statutoryPosting.create({
        data: {
          number,
          periodFrom: from,
          periodTo: to,
          note: data.note ?? null,
          createdById: req.user!.sub,
          lines: { create: wanted.map((l) => ({ componentId: l.componentId, workerId: l.workerId, wages: l.wages, employeeAmt: l.employeeAmt, employerAmt: l.employerAmt })) },
        },
        include: { lines: true },
      });
    });

    res.status(201).json(posting);
  })
);

router.delete(
  '/statutory/postings/:id',
  can('workers.view', 'statutory.view', 'statutory.post'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const posting = await prisma.statutoryPosting.findUnique({ where: { id }, include: { lines: { select: { componentId: true } } } });
    if (!posting) throw new ApiError(404, 'Posting not found.');
    const paid = await prisma.ledgerEntry.count({ where: { partyType: 'STATUTORY', statutoryComponentId: { in: [...new Set(posting.lines.map((l) => l.componentId))] } } });
    if (paid > 0) throw new ApiError(409, 'Money has already been paid against these levies. Reverse the payment first, or leave the posting in place.');
    await prisma.statutoryPosting.delete({ where: { id } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------------------
// The module dashboard
// ---------------------------------------------------------------------------

router.get(
  '/manforce/summary',
  canAny('workers.view', 'wages.view'),
  asyncHandler(async (_req, res) => {
    const today = dayStart(new Date());
    const [ctx, { rules, holidays }] = await Promise.all([buildWorkforceContext(), loadRules()]);
    const totals = workforceTotals(ctx);

    const [marks, holiday, postings] = await Promise.all([
      prisma.attendance.findMany({ where: { date: today } }),
      prisma.holiday.findUnique({ where: { date: today } }),
      prisma.statutoryPosting.findMany({ orderBy: [{ periodTo: 'desc' }], take: 1 }),
    ]);

    const active = [...ctx.accounts.values()].filter((a) => a.worker.isActive && dayStart(a.worker.joinedOn) <= today && (!a.worker.exitOn || dayStart(a.worker.exitOn) >= today));
    const working = isWorkingDay(today, rules, holidays);

    // Resolve each worker ONCE. Counting the presumption and the marks separately
    // would count a worker who was explicitly marked present twice over.
    const byWorker = new Map(marks.map((m) => [m.workerId, m]));
    let present = 0;
    let half = 0;
    let absent = 0;
    let presumed = 0;
    for (const a of active) {
      const status = byWorker.get(a.worker.id)?.status;
      if (status === 'HALF_DAY') half++;
      else if (status === 'ABSENT' || status === 'LEAVE') absent++;
      else if (status === 'PRESENT' || status === 'PAID_LEAVE') present++;
      else if (working && rules.presumePresent) {
        present++;
        presumed++;
      } else absent++;
    }

    res.json({
      headcount: totals.headcount,
      onRoll: active.length,
      contractors: totals.contractorCount,
      gangWorkers: ctx.contractors.reduce((a, c) => a + c.workers.length, 0),
      today: {
        date: today,
        isWorkingDay: working,
        holiday: holiday?.name ?? null,
        presumePresent: rules.presumePresent,
        marked: marks.length,
        /** Full days: explicitly marked present plus everyone presumed so. */
        present,
        absent,
        halfDay: half,
        overtimeHours: round(marks.reduce((a, m) => a + m.otHours, 0)),
        presumedPresent: presumed,
      },
      money: {
        wagesAccrued: totals.wagesAccrued,
        wagesPaid: totals.wagesPaid,
        workerDue: totals.workerDue,
        contractorDue: totals.contractorDue,
        advanceOutstanding: totals.advanceOutstanding,
        statutoryDue: totals.statutoryDue,
        statutoryProvision: totals.statutoryProvision,
        payable: totals.payableInr,
      },
      unlinked: ctx.unlinked,
      lastPosting: postings[0] ? { id: postings[0].id, number: postings[0].number, periodFrom: postings[0].periodFrom, periodTo: postings[0].periodTo } : null,
      // Who is owed the most, for the landing page.
      topDue: [...ctx.directWorkers]
        .filter((w) => w.position.dueNow > 0)
        .sort((a, b) => b.position.dueNow - a.position.dueNow)
        .slice(0, 8)
        .map((w) => ({ id: w.worker.id, code: w.worker.code, name: w.worker.name, dueNow: w.position.dueNow, earned: w.position.earned })),
      advances: [...ctx.accounts.values()]
        .filter((w) => w.position.advanceOutstanding > 0)
        .sort((a, b) => b.position.advanceOutstanding - a.position.advanceOutstanding)
        .slice(0, 8)
        .map((w) => ({ id: w.worker.id, code: w.worker.code, name: w.worker.name, outstanding: w.position.advanceOutstanding, recovered: w.position.advanceRecovered })),
    });
  })
);

export default router;
