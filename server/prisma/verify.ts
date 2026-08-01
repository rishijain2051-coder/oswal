/**
 * Self-checks that need no database state.
 *
 *   npm run verify
 *
 * The costing engine was reverse-engineered from `example.xlsx` (the "Crazy Almirah",
 * FOB ₹19,180.60). That workbook is the only external authority for the formulas, so
 * the check lives here as fixed numbers rather than depending on a seeded demo
 * product that any wipe would take away.
 *
 * The board and allocation invariants are checked the same way: pure functions, fixed
 * inputs, expected outputs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_METHODS, round, suggestCostDim, type MethodMap } from '../src/lib/costing';
import { computeCostSheet } from '../src/lib/productCosting';
import { rowToMethodDef } from '../src/lib/methods';
import { buildBoard, expandHops, impliedOrderStatus, spansOnePieceGroup, validateMove, type MoveRow, type StageRow } from '../src/lib/production';
import { allocateFifo, buildFinanceContext, buildStatement, jobworkEvents, receivablesByCurrency, type Bucket } from '../src/lib/finance';
import {
  CBM_MISMATCH_PCT,
  CBM_PER_CUBIC_INCH,
  cartonBoxCbm,
  cartonCbm,
  cartonsFor,
  containerFit,
  guardCartonFit,
  guardInvoiceQty,
  guardPackQty,
  guardShipQty,
  packedTotals,
  planContainers,
  round4,
  vgm,
} from '../src/lib/shipping';
import { finishedOnHand } from '../src/lib/finished';
import {
  DEFAULT_RULES,
  accrualStart,
  attendanceEarnings,
  computeStatutory,
  dayKey,
  dayStart,
  monthKey,
  isWorkingDay,
  labourEvents,
  monthlyPerDay,
  parseWeeklyOffDays,
  recoverAdvances,
  validateMoveWorkers,
  wageBase,
  workerPosition,
  workingDaysInMonth,
  type EarningEvent,
  type WorkforceRules,
} from '../src/lib/workforce';
import { assemble, normalizeKey, outlier, summarize, windowStart, type Occurrence } from '../src/lib/suggest';
import { chargeValue, docKeys, documentTotals, documentValue, lineNet, sameState } from '../src/lib/pricing';
import { DELIVERY_URGENCY, autoSchedule, daysBetween, deliveryStatus, estimateCompletion } from '../src/lib/scheduling';
import { survivesWipe } from './wipe';
import {
  PERMISSION_KEYS,
  PERMISSION_MODULES,
  PERMISSIONS,
  permissionDef,
  permissionsByModule,
  withRequired,
} from '../src/lib/permissions';
import { stripFulfilmentMoney, stripOrderMoney, stripOrderRates } from '../src/lib/moneyRedaction';

let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`}`);
  if (!ok) failed++;
}

// The built-in formulas, without touching the CostMethod table.
const methods: MethodMap = Object.fromEntries(BUILTIN_METHODS.map((m) => [m.code, rowToMethodDef(m as never)]));

const L = (name: string, o: Record<string, unknown>) => ({ name, qty: 1, wastagePct: 0, rate: 0, ...o });

// ---------------------------------------------------------------------------
// 1. Costing — the Crazy Almirah from example.xlsx
// ---------------------------------------------------------------------------

const crazyAlmirah = {
  currency: { code: 'INR', symbol: '₹' },
  factoryExpensePct: 15,
  marginPct: 15,
  groups: [
    {
      head: 'MAIN_COMPONENT',
      name: 'Mango Wood',
      method: 'CFT',
      dimUnit: 'IN',
      lines: [
        L('TOP', { actualL: 25, actualW: 32, actualH: 1, costL: 27, costW: 38.4, costH: 1, qty: 1, wastagePct: 20, rate: 560, unit: 'CFT' }),
        L('SIDE', { actualL: 59, actualW: 15, actualH: 1, costL: 63, costW: 18, costH: 1, qty: 2, wastagePct: 20, rate: 760, unit: 'CFT' }),
        L('PARTITION', { actualL: 56, actualW: 16, actualH: 1, costL: 60, costW: 19.2, costH: 1, qty: 1, wastagePct: 20, rate: 760, unit: 'CFT' }),
        L('SHELF', { actualL: 14, actualW: 17, actualH: 1, costL: 18, costW: 20.4, costH: 1, qty: 4, wastagePct: 20, rate: 560, unit: 'CFT' }),
        L('BOTTOM', { actualL: 24, actualW: 16, actualH: 1, costL: 27, costW: 19.2, costH: 1, qty: 1, wastagePct: 20, rate: 560, unit: 'CFT' }),
        L('DOOR FRAME', { actualL: 56, actualW: 13, actualH: 1.5, costL: 60, costW: 15.6, costH: 1.5, qty: 1, wastagePct: 20, rate: 760, unit: 'CFT' }),
      ],
    },
    { head: 'MAIN_COMPONENT', name: 'Oak Wood', method: 'SQFT', dimUnit: 'IN', lines: [L('DOOR PANEL', { actualL: 34, actualW: 16, costL: 36, costW: 19.2, qty: 1, wastagePct: 20, rate: 490, unit: 'SQFT' })] },
    { head: 'SUB_COMPONENT', name: 'Iron — Powdercoated Fitting', method: 'WEIGHT', lines: [L('PWDRFTG/133', { actualWeight: 14.38, wastagePct: 4.31, qty: 1, rate: 182, unit: 'KGS' })] },
    { head: 'SUB_COMPONENT', name: 'Iron — Powdercoated Legs', method: 'QTY', lines: [L('PWDRCTDLGS/1452', { qty: 1, rate: 1200, unit: 'PCS' })] },
    {
      head: 'SUB_COMPONENT',
      name: 'Ply 6mm',
      method: 'SQFT',
      dimUnit: 'IN',
      lines: [L('BACK PLY', { actualL: 18, actualW: 32, costL: 18, costW: 32, qty: 2, rate: 30, unit: 'SQFT' }), L('BOTTOM PLY', { actualL: 19, actualW: 12, costL: 19, costW: 12, qty: 5, rate: 30, unit: 'SQFT' })],
    },
    { head: 'SUB_COMPONENT', name: 'Ply 8mm', method: 'SQMT', dimUnit: 'CM', lines: [L('BOTTOM SUPPORT', { actualL: 42, actualW: 30, costL: 42, costW: 30, qty: 1, rate: 960, unit: 'SQM' })] },
    { head: 'SUB_COMPONENT', name: 'Glass 4mm', method: 'SQFT', dimUnit: 'IN', lines: [L('DOOR GLASS', { actualL: 12, actualW: 18, costL: 12, costW: 18, qty: 1, rate: 130, unit: 'SQFT' })] },
    {
      head: 'HARDWARE',
      name: 'Hardware',
      method: 'QTY',
      lines: [
        L("11' HANDLE", { qty: 2, rate: 63, unit: 'PCS' }),
        L("1.5' SCREW", { qty: 30, rate: 0.82, unit: 'PCS' }),
        L('F35 NAILS', { qty: 2, rate: 50, unit: 'SET' }),
        L("2' BRASS KNOB", { qty: 1, rate: 112, unit: 'PCS' }),
        L('60N PAPER', { qty: 3, rate: 58, unit: 'PCS' }),
        L('120N PAPER', { qty: 3, rate: 39, unit: 'PCS' }),
        L("10' CHAIN", { qty: 1, rate: 12, unit: 'PCS' }),
      ],
    },
    {
      head: 'POLISHING',
      name: 'Polishing',
      method: 'QTY',
      lines: [
        L('THINNER', { qty: 2, rate: 25, unit: 'LTR' }),
        L('SEALER', { qty: 2, rate: 28, unit: 'LTR' }),
        L('LACQUER', { qty: 2, rate: 30, unit: 'LTR' }),
        L('ROUGH CLOTH', { qty: 2, rate: 7, unit: 'PCS' }),
        L('SANDING PAPER', { qty: 1.5, rate: 80, unit: 'PCS' }),
      ],
    },
    {
      head: 'PACKAGING',
      name: 'Packaging',
      method: 'QTY',
      lines: [L('BUBBLE', { qty: 0.88, rate: 230, unit: 'MTR' }), L('FOAM', { qty: 0.78, rate: 210, unit: 'MTR' }), L('CARTON 7PLY', { qty: 1, rate: 580, unit: 'PCS' }), L('CORNERS', { qty: 8, rate: 2.8, unit: 'PCS' })],
    },
    {
      head: 'LABOUR',
      name: 'Labour',
      method: 'QTY',
      lines: [
        L('CNC LABOUR', { qty: 1, rate: 100, unit: 'LOT' }),
        L('CARVING LABOUR', { qty: 1, rate: 260, unit: 'LOT' }),
        L('MANUFACTURING LABOUR', { qty: 1, rate: 500, unit: 'LOT' }),
        L('POLISHING LABOUR', { qty: 1, rate: 428, unit: 'LOT' }),
        L('PACKAGING LABOUR', { qty: 1, rate: 180, unit: 'LOT' }),
        L('LOADING LABOUR', { qty: 1, rate: 110, unit: 'LOT' }),
      ],
    },
    { head: 'FORWARDING', name: 'Forwarding', method: 'QTY', lines: [L('CHA', { qty: 1, rate: 98, unit: 'LOT' }), L('FORWARDER', { qty: 1, rate: 580, unit: 'LOT' }), L('ICD', { qty: 1, rate: 136, unit: 'LOT' })] },
  ],
};

const computed = computeCostSheet(crazyAlmirah as never, methods) as any;
console.log('\n--- costing engine, against example.xlsx ---');
check('FOB per piece', round(computed.summary.fob), 19180.6);
check('Ex-factory excludes forwarding', round(computed.summary.exFactory), round(computed.summary.headTotals.MAIN_COMPONENT + computed.summary.headTotals.SUB_COMPONENT + computed.summary.headTotals.HARDWARE + computed.summary.headTotals.POLISHING + computed.summary.headTotals.PACKAGING + computed.summary.headTotals.LABOUR));
check('Non-FOB is FOB less the forwarding roll-up', computed.summary.nonFob < computed.summary.fob, true);
check('TOP measures 6 CFT at 10 pcs', round(computed.groups[0].lines[0].measure * 10, 3), 6);

// ---------------------------------------------------------------------------
// 2. Board arithmetic
// ---------------------------------------------------------------------------

const stages: StageRow[] = ['Raw joining', 'Raw sanding', 'Polishing', 'QC', 'Packing'].map((name, i) => ({
  id: i + 1,
  name,
  sortOrder: i,
  vendorId: i === 2 ? 99 : null,
  jobworkRate: i === 2 ? 40 : 0,
  vendor: i === 2 ? { id: 99, name: 'Polish Co.' } : null,
}));
const mv = (id: number, kind: string, from: number | null, to: number | null, qty: number, day = 1): MoveRow => ({ id, kind, fromStageId: from, toStageId: to, qty, date: new Date(2026, 0, day) });

console.log('\n--- production board ---');
let board = buildBoard(10, stages, [mv(1, 'RELEASE', null, 1, 10)]);
check('release fills stage 1', [board.pending, board.stages[0].at, board.wip, board.done], [0, 10, 10, 0]);

board = buildBoard(10, stages, [mv(1, 'RELEASE', null, 1, 10), mv(2, 'ADVANCE', 1, 2, 6), mv(3, 'ADVANCE', 2, 3, 6), mv(4, 'ADVANCE', 3, 4, 6)]);
check('pieces land where sent', [board.stages[0].at, board.stages[3].at], [4, 6]);
check('jobwork accrues only on the vendor stage', board.jobwork, [{ vendorId: 99, vendorName: 'Polish Co.', stages: ['Polishing'], pieces: 6, amount: 240 }]);
check('pieces are conserved', board.pending + board.wip + board.done, 10);

board = buildBoard(10, stages, [mv(1, 'RELEASE', null, 1, 10), mv(2, 'ADVANCE', 1, 4, 10), mv(3, 'REJECT', 4, 3, 4), mv(4, 'COMPLETE', 4, null, 6)]);
check('rejection sends pieces back', board.stages[2].at, 4);
check('completion empties into done', board.done, 6);
check('rework is still conserved', board.pending + board.wip + board.done, 10);

console.log('\n--- move rules ---');
check('cannot over-move', validateMove(board, { kind: 'ADVANCE', fromStageId: 3, toStageId: 4, qty: 99 }), 'Only 4 pc(s) available at Polishing.');
check('cannot advance backwards', validateMove(board, { kind: 'ADVANCE', fromStageId: 3, toStageId: 2, qty: 1 }), 'Advancing must move forward — use "send back" to return pieces to an earlier stage.');
check('cannot reject forwards', validateMove(board, { kind: 'REJECT', fromStageId: 3, toStageId: 4, qty: 1 }), 'Sending back must move to an earlier stage.');
check('cannot release into nothing', validateMove(board, { kind: 'RELEASE', toStageId: null, qty: 1 }), 'Pick the stage to release pieces into.');
check('a legal move passes', validateMove(board, { kind: 'ADVANCE', fromStageId: 3, toStageId: 4, qty: 4 }), null);

console.log('\n--- multi-step clearance ---');
const full = buildBoard(10, stages, [mv(1, 'RELEASE', null, 1, 10)]);
check('advancing 1 -> 4 records three hops', expandHops(full, { kind: 'ADVANCE', fromStageId: 1, toStageId: 4, qty: 5 }).map((h) => [h.fromStageId, h.toStageId]), [[1, 2], [2, 3], [3, 4]]);
check('a single-stage advance stays one hop', expandHops(full, { kind: 'ADVANCE', fromStageId: 1, toStageId: 2, qty: 5 }).length, 1);
check('finishing early never walks the line', expandHops(full, { kind: 'COMPLETE', fromStageId: 1, toStageId: null, qty: 5 }), [{ kind: 'COMPLETE', fromStageId: 1, toStageId: null, qty: 5 }]);
check('rejection is one event', expandHops(full, { kind: 'REJECT', fromStageId: 4, toStageId: 1, qty: 2 }).length, 1);

// Finishing early must not credit the vendor whose stage was skipped.
const skipped = buildBoard(10, stages, [mv(1, 'RELEASE', null, 1, 10), mv(2, 'COMPLETE', 1, null, 10)]);
check('skipped vendor stage earns nothing', skipped.jobwork, []);

// ---------------------------------------------------------------------------
// 3. Jobwork events
// ---------------------------------------------------------------------------

console.log('\n--- jobwork history ---');
const line = {
  id: 1,
  qty: 10,
  product: { factoryCode: 'AB-1', name: 'Test' },
  stages: stages as never,
  moves: [mv(1, 'RELEASE', null, 1, 10, 1), mv(2, 'ADVANCE', 1, 3, 10, 2), mv(3, 'ADVANCE', 3, 4, 6, 3), mv(4, 'REJECT', 4, 3, 2, 4), mv(5, 'ADVANCE', 3, 4, 2, 5)] as never,
};
const events = jobworkEvents({ id: 1, number: 'ORD-1' }, line as never);
check('one earning per clearance out of the vendor stage', events.length, 2);
check('earnings equal pieces x rate', events.map((e) => e.amount), [240, 80]);
check('the re-done clearance is flagged', events.map((e) => e.rework), [false, true]);
check('events reconcile with the board', round(events.reduce((a, e) => a + e.amount, 0)), buildBoard(10, stages, line.moves as never).jobwork[0].amount);

// ---------------------------------------------------------------------------
// 4. FIFO allocation
// ---------------------------------------------------------------------------

console.log('\n--- FIFO allocation ---');
const buckets: Bucket[] = [
  { key: 'o1', orderId: 1, label: 'ORD-1', date: new Date(2026, 0, 1), gross: 1000 },
  { key: 'o2', orderId: 2, label: 'ORD-2', date: new Date(2026, 0, 10), gross: 2000 },
  { key: 'o3', orderId: 3, label: 'ORD-3', date: new Date(2026, 0, 20), gross: 3000 },
];
let alloc = allocateFifo(buckets, [{ id: 1, date: new Date(2026, 1, 1), amount: 2500, orderId: 1 }]);
check('names its order first, then spills to the next oldest', alloc.payments[0].allocations.map((a) => [a.label, a.amount]), [['ORD-1', 1000], ['ORD-2', 1500]]);
check('balances left behind', alloc.buckets.map((b) => b.balance), [0, 500, 3000]);
check('nothing on account yet', alloc.credit, 0);

alloc = allocateFifo(buckets, [{ id: 1, date: new Date(2026, 1, 1), amount: 7000 }]);
check('a payment with no order works oldest-first', alloc.buckets.map((b) => b.balance), [0, 0, 0]);
check('the surplus becomes credit', alloc.credit, 1000);

alloc = allocateFifo(buckets, [{ id: 1, date: new Date(2026, 1, 1), amount: 500, orderId: 3 }]);
check('a stated order is honoured over age', alloc.buckets.map((b) => b.balance), [1000, 2000, 2500]);

alloc = allocateFifo([], [{ id: 1, date: new Date(2026, 1, 1), amount: 900 }]);
check('with nothing outstanding it is all credit', alloc.credit, 900);

alloc = allocateFifo(buckets, [
  { id: 1, date: new Date(2026, 1, 1), amount: 400 },
  { id: 2, date: new Date(2026, 1, 2), amount: 900 },
]);
check('two payments queue in date order', alloc.buckets.map((b) => b.paid), [1000, 300, 0]);

console.log('\n--- statement ---');
const st = buildStatement([
  { date: new Date(2026, 0, 1), type: 'INVOICE', description: 'Order', charge: 1000, settle: 0 },
  { date: new Date(2026, 0, 5), type: 'RECEIPT', description: 'Receipt', charge: 0, settle: 400 },
  { date: new Date(2026, 0, 9), type: 'INVOICE', description: 'Order', charge: 500, settle: 0 },
]);
check('running balance walks the rows', st.map((r) => r.balance), [1000, 600, 1100]);
check('rows carry a stable key', st.every((r) => typeof r.key === 'string' && r.key.length > 0), true);

// ---------------------------------------------------------------------------
// 5. Rounding — the same helper decides every money figure on both sides
// ---------------------------------------------------------------------------

console.log('\n--- rounding ---');
check('near-tie rounds up', round(1.005), 1.01);
check('negatives round symmetrically', round(-1.005), -1.01);
check('a negative is the mirror of its positive', round(-2.675), -round(2.675));
check('plain values are untouched', [round(0), round(12.34), round(-12.34)], [0, 12.34, -12.34]);
check('three decimals work too', round(1.0005, 3), 1.001);
check('infinities pass through', [round(Infinity), round(-Infinity)], [Infinity, -Infinity]);
// The client mirrors this exactly; suggestCostDim must agree with the server.
check('cost-dim suggestion matches the server rule', suggestCostDim(25, 20), round(25 * 1.2, 3));
check('a thousand small amounts still add up', round(Array.from({ length: 1000 }, () => 0.01).reduce((a, b) => round(a + b), 0)), 10);

// ---------------------------------------------------------------------------
// 6. Manforce — attendance, piece work, statutory dues, advances
//
// There are no pay periods: a worker is a running account. So what matters here is
// that earnings are DERIVED correctly from the calendar and the board, and that the
// two figures the UI shows — cash due now and the party balance — differ by exactly
// the advance still outstanding.
// ---------------------------------------------------------------------------

console.log('\n--- working-day calendar ---');
const rules: WorkforceRules = { ...DEFAULT_RULES };
// January 2026 starts on a Thursday, so the 4th, 11th, 18th and 25th are Sundays.
const holidays = new Set<string>(['2026-01-05']);
check('a Sunday is not a working day', isWorkingDay(new Date(2026, 0, 4), rules, holidays), false);
check('a holiday is not a working day', isWorkingDay(new Date(2026, 0, 5), rules, holidays), false);
check('an ordinary day is', isWorkingDay(new Date(2026, 0, 6), rules, holidays), true);
check('weekly offs parse from CSV', parseWeeklyOffDays('0, 6, 9, x'), [0, 6]);
// Attendance is a calendar fact, so a date must read as the LOCAL day. Formatting a
// local midnight with toISOString() names the day BEFORE anywhere east of UTC, which
// would silently shift a whole muster — and a statutory period — by one day.
check('a day key reads the local date, not the UTC one', dayKey(new Date(2026, 0, 5)), '2026-01-05');
check('and survives a round trip through midnight', dayKey(dayStart(new Date(2026, 0, 5, 23, 59))), '2026-01-05');
check('a month key does too', monthKey(new Date(2026, 0, 1)), '2026-01');
check('January 2026 has 27 working days before holidays', workingDaysInMonth('2026-01', DEFAULT_RULES, new Set()), 27);
check('a holiday removes one', workingDaysInMonth('2026-01', DEFAULT_RULES, holidays), 26);

console.log('\n--- day wages, exceptions only ---');
const dayWorker = { id: 1, payType: 'DAY', dailyRate: 500, otHourlyRate: 0, monthlySalary: 0, joinedOn: new Date(2025, 0, 1) };
const week = { from: new Date(2026, 0, 1), to: new Date(2026, 0, 7) };
const earned = (att: { date: Date; status: string; otHours?: number }[], hol = new Set<string>()) => round(attendanceEarnings(dayWorker, att, week.from, week.to, rules, hol).reduce((a, e) => a + e.amount, 0));
check('nobody marked = everyone presumed present', earned([]), 3000); // 6 working days x 500
check('an absence docks a day', earned([{ date: new Date(2026, 0, 2), status: 'ABSENT' }]), 2500);
check('a half day docks half', earned([{ date: new Date(2026, 0, 3), status: 'HALF_DAY' }]), 2750);
check('unpaid leave earns nothing, paid leave earns fully', earned([{ date: new Date(2026, 0, 2), status: 'LEAVE' }, { date: new Date(2026, 0, 3), status: 'PAID_LEAVE' }]), 2500);
check('a holiday is not paid', earned([], holidays), 2500);
check('working a holiday is paid', earned([{ date: new Date(2026, 0, 5), status: 'PRESENT' }], holidays), 3000);
check('working a Sunday is paid', earned([{ date: new Date(2026, 0, 4), status: 'PRESENT' }]), 3500);
check('an unmarked Sunday is not', earned([]), 3000);
check('overtime derives its rate from the day', earned([{ date: new Date(2026, 0, 6), status: 'PRESENT', otHours: 3 }]), 3375); // (500/8)*2 = 125/h
check('nothing accrues before joining', round(attendanceEarnings({ ...dayWorker, joinedOn: new Date(2026, 0, 6) }, [], week.from, week.to, rules, new Set()).reduce((a, e) => a + e.amount, 0)), 1000);
check('nothing accrues after leaving', round(attendanceEarnings({ ...dayWorker, exitOn: new Date(2026, 0, 2) }, [], week.from, week.to, rules, new Set()).reduce((a, e) => a + e.amount, 0)), 1000);
// A worker migrated from typed wage entries must not have days invented for the
// period those entries already covered.
check('nothing accrues before the accrual start', round(attendanceEarnings({ ...dayWorker, accrualFrom: new Date(2026, 0, 6) }, [], week.from, week.to, rules, new Set()).reduce((a, e) => a + e.amount, 0)), 1000);
check('an accrual start before joining cannot widen the window', accrualStart({ ...dayWorker, joinedOn: new Date(2026, 0, 6), accrualFrom: new Date(2025, 0, 1) }).getTime(), new Date(2026, 0, 6).getTime());
check('a piece-rate worker earns nothing from attendance', attendanceEarnings({ ...dayWorker, payType: 'PIECE' }, [{ date: new Date(2026, 0, 2), status: 'PRESENT' }], week.from, week.to, rules, new Set()), []);
check('presuming nothing pays only what is marked', round(attendanceEarnings(dayWorker, [{ date: new Date(2026, 0, 2), status: 'PRESENT' }], week.from, week.to, { ...rules, presumePresent: false }, new Set()).reduce((a, e) => a + e.amount, 0)), 500);

console.log('\n--- monthly salary, pro-rata ---');
const salaried = { id: 2, payType: 'MONTHLY', dailyRate: 0, otHourlyRate: 0, monthlySalary: 27000, joinedOn: new Date(2025, 0, 1) };
const janAll = attendanceEarnings(salaried, [], new Date(2026, 0, 1), new Date(2026, 0, 31), rules, new Set());
check('a full month accrues the salary', round(janAll.reduce((a, e) => a + e.amount, 0)), 27000); // 27 working days x ₹1000
check('it accrues day by day, not as a lump', janAll.length, 27);
check('mid-month it is already worth something', round(attendanceEarnings(salaried, [], new Date(2026, 0, 1), new Date(2026, 0, 15), rules, new Set()).reduce((a, e) => a + e.amount, 0)), 13000);
check('an absence docks exactly one working day', round(attendanceEarnings(salaried, [{ date: new Date(2026, 0, 6), status: 'ABSENT' }], new Date(2026, 0, 1), new Date(2026, 0, 31), rules, new Set()).reduce((a, e) => a + e.amount, 0)), 26000);
check('a 26-day basis divides by 26', round(monthlyPerDay(26000, '2026-01', { ...rules, monthlyDivisor: 'FIXED_26' }, new Set())), 1000);

console.log('\n--- in-house piece work off the board ---');
const inHouse: StageRow[] = ['Joining', 'Polishing', 'Packing'].map((name, i) => ({ id: i + 1, name, sortOrder: i, vendorId: null, jobworkRate: 0, labourRate: i === 1 ? 40 : 0 }) as StageRow);
const withWorkers = (id: number, kind: string, from: number | null, to: number | null, qty: number, day: number, workers?: { workerId: number; pieces: number }[]) => ({ ...mv(id, kind, from, to, qty, day), workers });
const labourLine = {
  id: 1,
  product: { factoryCode: 'AB-1', name: 'Test' },
  stages: inHouse as never,
  moves: [
    withWorkers(1, 'RELEASE', null, 1, 10, 1),
    withWorkers(2, 'ADVANCE', 1, 2, 10, 2),
    withWorkers(3, 'ADVANCE', 2, 3, 6, 3, [{ workerId: 7, pieces: 4 }, { workerId: 8, pieces: 2 }]),
    withWorkers(4, 'REJECT', 3, 2, 2, 4),
    withWorkers(5, 'ADVANCE', 2, 3, 2, 5, [{ workerId: 7, pieces: 2 }]),
  ] as never,
};
const pieceEvents = labourEvents({ id: 1, number: 'ORD-1' }, labourLine as never);
check('one earning per named worker per clearance', pieceEvents.length, 3);
check('each worker earns their own pieces x the stage rate', pieceEvents.map((e) => [e.workerId, e.amount]), [[7, 160], [8, 80], [7, 80]]);
check('re-done work earns again, and says so', pieceEvents[2].label, 'Polishing — 2 pc (re-done)');
check('piece earnings reconcile with the board', round(pieceEvents.reduce((a, e) => a + e.amount, 0)), round(buildBoard(10, inHouse, labourLine.moves as never).stages[1].cleared * 40));
check('a clearance with nobody named pays nobody', labourEvents({ id: 1, number: 'ORD-1' }, { ...labourLine, moves: [withWorkers(2, 'ADVANCE', 1, 2, 10, 2)] } as never), []);

// The board is what the UI reads a stage's rate back out of. It was once built
// field-by-field without labourRate, so a rate saved fine but always displayed as
// blank — and the move drawer refused to attribute work to anyone.
const rateBoard = buildBoard(10, inHouse, labourLine.moves as never);
check('the board carries each stage its in-house piece rate', rateBoard.stages.map((s) => s.labourRate), [0, 40, 0]);
check('and prices the pieces cleared out of it', rateBoard.stages[1].labourValue, 320); // 8 cleared x 40
check('an outsourced stage reports no in-house labour value', buildBoard(10, inHouse.map((s) => ({ ...s, vendorId: 99, jobworkRate: 10 })), labourLine.moves as never).stages[1].labourValue, 0);
check('the stage labour value agrees with the piece earnings', round(rateBoard.stages.reduce((a, s) => a + s.labourValue, 0)), round(pieceEvents.reduce((a, e) => a + e.amount, 0)));

console.log('\n--- naming workers on a movement ---');
const polishing = { vendorId: null, labourRate: 40, name: 'Polishing' };
check('pieces must add up to the movement', validateMoveWorkers(10, [{ workerId: 7, pieces: 4 }, { workerId: 8, pieces: 2 }], polishing), 'The pieces per worker add up to 6, but 10 pc are being moved.');
check('an exact split passes', validateMoveWorkers(6, [{ workerId: 7, pieces: 4 }, { workerId: 8, pieces: 2 }], polishing), null);
check('naming nobody is always allowed', validateMoveWorkers(6, [], polishing), null);
check('the same worker cannot be listed twice', validateMoveWorkers(6, [{ workerId: 7, pieces: 4 }, { workerId: 7, pieces: 2 }], polishing), 'The same worker is listed twice — combine their pieces into one line.');
check('an outsourced stage pays its vendor, not workers', validateMoveWorkers(6, [{ workerId: 7, pieces: 6 }], { vendorId: 99, labourRate: 0, name: 'Polishing' }), 'Polishing is outsourced — the vendor is paid for it, so workers cannot be named on it.');
check('a stage with no rate cannot pay the workers named on it', validateMoveWorkers(6, [{ workerId: 7, pieces: 6 }], { ...polishing, labourRate: 0 }), 'Polishing has no piece rate, so there is nothing to pay the workers named on it. Set a labour rate on the stage first.');

console.log('\n--- statutory components ---');
const pf = { id: 1, code: 'PF', name: 'Provident Fund', employeePct: 12, employerPct: 12, flatAmount: 0, basis: 'BASIC', wageCeiling: 15000, eligibilityCeiling: null, minWages: null };
const esi = { id: 2, code: 'ESI', name: 'ESI', employeePct: 0.75, employerPct: 3.25, flatAmount: 0, basis: 'GROSS', wageCeiling: null, eligibilityCeiling: 21000, minWages: null };
const pt = { id: 3, code: 'PT', name: 'Professional tax', employeePct: 0, employerPct: 0, flatAmount: 200, basis: 'GROSS', wageCeiling: null, eligibilityCeiling: null, minWages: 15000 };
check('PF caps the base at the ceiling and ignores overtime', [computeStatutory(pf, { gross: 20000, basic: 18000 }).employeeAmt, computeStatutory(pf, { gross: 20000, basic: 18000 }).employerAmt], [1800, 1800]);
check('below the ceiling PF uses the actual wage', computeStatutory(pf, { gross: 12000, basic: 12000 }).employeeAmt, 1440);
check('ESI splits employee and employer', [computeStatutory(esi, { gross: 20000, basic: 20000 }).employeeAmt, computeStatutory(esi, { gross: 20000, basic: 20000 }).employerAmt], [150, 650]);
check('above its eligibility ceiling ESI does not apply', computeStatutory(esi, { gross: 22000, basic: 22000 }).covered, false);
check('a flat component is a flat amount', computeStatutory(pt, { gross: 16000, basic: 16000 }).employeeAmt, 200);
check('below its threshold it does not apply', computeStatutory(pt, { gross: 14000, basic: 14000 }).employeeAmt, 0);
check('no wages, nothing due', computeStatutory(pf, { gross: 0, basic: 0 }).covered, false);
const otWeek = attendanceEarnings(dayWorker, [{ date: new Date(2026, 0, 6), status: 'PRESENT', otHours: 3 }], week.from, week.to, rules, new Set());
check('the BASIC base excludes overtime', wageBase(otWeek), { gross: 3375, basic: 3000 });

console.log('\n--- advances, recovered from earnings ---');
const evt = (day: number, amount: number): EarningEvent => ({ key: `e${day}-${amount}`, workerId: 1, date: new Date(2026, day < 32 ? 0 : 1, day < 32 ? day : day - 31), kind: 'DAY', label: 'Present', days: 1, hours: 0, pieces: 0, rate: amount, amount, overtime: false });
const janFeb = [evt(10, 3000), evt(40, 3000)]; // ₹3,000 in January, ₹3,000 in February
const capped = workerPosition({ workerId: 1, earnings: janFeb, deductions: [], statutory: [], advances: [{ id: 1, date: new Date(2026, 0, 5), amount: 10000, recoveryPerMonth: 1000 }], payments: [] });
check('a capped advance recovers only its cap each month', capped.advanceRecovered, 2000);
check('the rest stays outstanding', capped.advanceOutstanding, 8000);
check('cash is still due despite the advance', capped.dueNow, 4000);
check('the party balance shows the worker in debt', capped.balance, -4000);
check('due now less the advance outstanding IS the balance', round(capped.dueNow - capped.advanceOutstanding), capped.balance);

const uncapped = workerPosition({ workerId: 1, earnings: [evt(10, 2000)], deductions: [], statutory: [], advances: [{ id: 1, date: new Date(2026, 0, 5), amount: 5000, recoveryPerMonth: 0 }], payments: [] });
check('an uncapped advance is just a payment that outran the earnings', [uncapped.advanceRecovered, uncapped.advanceOutstanding, uncapped.dueNow, uncapped.balance], [2000, 3000, 0, -3000]);
check('and the identity still holds', round(uncapped.dueNow - uncapped.advanceOutstanding), uncapped.balance);

const backdated = recoverAdvances([{ id: 1, date: new Date(2026, 1, 1), amount: 5000, recoveryPerMonth: 0 }], [evt(10, 3000)]);
check('earnings from before an advance cannot recover it', backdated.advances[0].outstanding, 5000);

const settled = workerPosition({
  workerId: 1,
  earnings: janFeb,
  deductions: [{ id: 1, date: new Date(2026, 0, 20), amount: 300, label: 'Canteen' }],
  statutory: [{ id: 1, date: new Date(2026, 0, 31), amount: 360, label: 'PF' }],
  advances: [],
  payments: [{ id: 1, date: new Date(2026, 1, 10), amount: 2000, label: 'Wages' }],
});
check('deductions and statutory reduce what is owed', settled.dueNow, 3340); // 6000 - 300 - 360 - 2000
check('with no advance, due now and the balance agree', [settled.dueNow, settled.balance], [3340, 3340]);
check('an empty account is zero everywhere', workerPosition({ workerId: 1, earnings: [], deductions: [], statutory: [], advances: [], payments: [] }).balance, 0);

// ---------------------------------------------------------------------------
// 7. Suggestions — "what did we use last time"
//
// Derived from live records, so what matters here is the maths that decides which
// figure leads and whether a typed one looks wrong. The client mirrors `outlier()`
// so the note can update as you type; both must agree.
// ---------------------------------------------------------------------------

console.log('\n--- matching the same item across products ---');
check('case and spacing are noise', [normalizeKey('CARVING LABOUR'), normalizeKey('Carving  Labour'), normalizeKey('  carving labour ')], ['carving labour', 'carving labour', 'carving labour']);
check('different wording stays different', normalizeKey('CARVING LABOR') === normalizeKey('CARVING LABOUR'), false);
check('nothing normalises to nothing', normalizeKey(null), '');

console.log('\n--- summarising past uses ---');
const occ = (value: number, day: number, label = 'AB-1'): Occurrence => ({ value, date: new Date(2026, 0, day), label });
const stats = summarize('COSTED', 'Costed before', [occ(240, 5), occ(280, 20), occ(260, 12)]);
check('the newest use leads', stats.last!.value, 280);
check('the range is the range', [stats.min, stats.max], [240, 280]);
check('the average is the average', stats.avg, 260);
check('a zero or negative figure is not a use', summarize('X', 'x', [occ(0, 1), occ(-5, 2), occ(100, 3)]).count, 1);
check('no history means no suggestion', summarize('X', 'x', []).last, null);

console.log('\n--- out of line ---');
check('a fat-fingered figure is flagged', outlier(2600, stats, 25).flag, 'HIGH');
check('and says how far off it is', Math.round(outlier(2600, stats, 25).pct), 900);
check('an unusually low one too', outlier(100, stats, 25).flag, 'LOW');
check('a sensible figure is not', outlier(270, stats, 25).flag, null);
check('the threshold is respected', [outlier(330, stats, 25).flag, outlier(330, stats, 30).flag], ['HIGH', null]);
// One previous use is not a pattern; warning on it would cry wolf on every new item.
check('a single past use never warns', outlier(9999, summarize('X', 'x', [occ(100, 1)]), 25).flag, null);
check('an empty field never warns', outlier(null, stats, 25).flag, null);
check('the reference is the average, not the last', outlier(2600, stats, 25).reference, 260);

console.log('\n--- which source leads ---');
const costedSrc = summarize('COSTED', 'Costed before', [occ(260, 10)]);
const purchasedSrc = summarize('PURCHASED', 'A supplier billed', [occ(612, 12)]);
const emptySrc = summarize('JOBWORK', 'Vendors charged', []);
check('the most comparable source with history leads', assemble('k', 'CARVING LABOUR', [costedSrc, purchasedSrc]).primary!.kind, 'COSTED');
check('an empty source is dropped, not shown blank', assemble('k', 'x', [emptySrc, purchasedSrc]).sources.map((s) => s.kind), ['PURCHASED']);
check('sources are kept separate, never averaged', assemble('k', 'x', [costedSrc, purchasedSrc]).sources.map((s) => s.last!.value), [260, 612]);
check('nothing anywhere means nothing to suggest', assemble('k', 'x', [emptySrc]).primary, null);

console.log('\n--- the window ---');
check('a window is a cut-off date in the past', windowStart(365)! < new Date(), true);
// Measured from today's local midnight, not from now: windowStart snaps to midnight so
// the whole cut-off day counts, which made a "now" comparison read 366 after midday.
const localMidnight = new Date();
localMidnight.setHours(0, 0, 0, 0);
check('365 days back is 365 days back', Math.round((localMidnight.getTime() - windowStart(365)!.getTime()) / 86400000), 365);
check('the cut-off is a local midnight, so the whole day counts', [windowStart(365)!.getHours(), windowStart(365)!.getMinutes()], [0, 0]);
check('zero days means no limit', windowStart(0), null);

// ---------------------------------------------------------------------------
// Document pricing — what a proforma or order is worth
// ---------------------------------------------------------------------------

console.log('\n--- line discounts ---');
check('a plain line is qty x price', lineNet({ qty: 10, unitPrice: 250 }), 2500);
check('a percentage comes off the gross', lineNet({ qty: 10, unitPrice: 250, discountPct: 10 }), 2250);
check('a flat amount comes off after the percentage', lineNet({ qty: 10, unitPrice: 250, discountPct: 10, discountAmt: 250 }), 2000);
// A discount bigger than the line would otherwise make the document owe the buyer.
check('a line can never go negative', lineNet({ qty: 1, unitPrice: 100, discountAmt: 500 }), 0);
check('paise are kept, not truncated', lineNet({ qty: 3, unitPrice: 33.33 }), 99.99);

console.log('\n--- document charges ---');
const sub = 10000;
check('a flat charge is itself', chargeValue({ kind: 'CHARGE', amount: 1800 }, sub), 1800);
check('a discount is the same magnitude, negative', chargeValue({ kind: 'DISCOUNT', amount: 1800 }, sub), -1800);
check('a percentage charge is of the line subtotal', chargeValue({ kind: 'CHARGE', pct: 5 }, sub), 500);
check('a percentage discount too', chargeValue({ kind: 'DISCOUNT', pct: 5 }, sub), -500);
check('a charge with both adds them', chargeValue({ kind: 'CHARGE', pct: 5, amount: 100 }, sub), 600);
// Stored magnitudes are always positive; only `kind` decides the sign, so a negative
// amount typed against a discount must not flip it back into a charge.
check('a negative amount cannot invert a discount', chargeValue({ kind: 'DISCOUNT', amount: -500 }, sub), -500);

console.log('\n--- overseas is zero-rated ---');
const exportLines = [{ qty: 20, unitPrice: 100, gstRatePct: 18 }];
const exportDoc = documentTotals(exportLines, [{ kind: 'CHARGE', name: 'Freight', amount: 500, gstRatePct: 18 }], { market: 'OVERSEAS', buyerState: 'Rajasthan', companyState: 'Rajasthan' });
check('an export subtotal is the lines', exportDoc.subtotal, 2000);
check('a stray GST rate on an export is ignored', exportDoc.taxTotal, 0);
check('and no split is claimed', [exportDoc.cgst, exportDoc.sgst, exportDoc.igst], [0, 0, 0]);
check('an export total is lines plus charges only', exportDoc.grandTotal, 2500);
check('an export says it was not taxed', exportDoc.taxed, false);

console.log('\n--- domestic, same state: CGST + SGST ---');
const intra = documentTotals(
  [{ qty: 10, unitPrice: 1000, gstRatePct: 18 }],
  [{ kind: 'CHARGE', name: 'Freight', amount: 1000, gstRatePct: 18 }],
  { market: 'DOMESTIC', buyerState: 'Rajasthan', companyState: 'Rajasthan' }
);
check('the taxable value includes the taxable charge', intra.taxableValue, 11000);
check('tax is charged on it at the rate', intra.taxTotal, 1980);
check('and splits half and half', [intra.cgst, intra.sgst], [990, 990]);
check('with no IGST', intra.igst, 0);
check('the total is value plus tax', intra.grandTotal, 12980);
check('it reports the split it used', intra.intraState, true);

console.log('\n--- domestic, other state: IGST ---');
const inter = documentTotals(
  [{ qty: 10, unitPrice: 1000, gstRatePct: 18 }],
  [{ kind: 'CHARGE', name: 'Freight', amount: 1000, gstRatePct: 18 }],
  { market: 'DOMESTIC', buyerState: 'Gujarat', companyState: 'Rajasthan' }
);
check('the same money is taxed the same', inter.taxTotal, 1980);
check('but all of it is IGST', [inter.cgst, inter.sgst, inter.igst], [0, 0, 1980]);
check('the grand total is identical either way', inter.grandTotal, intra.grandTotal);

console.log('\n--- more than one GST slab ---');
const slabs = documentTotals(
  [
    { qty: 1, unitPrice: 10000, gstRatePct: 18 },
    { qty: 1, unitPrice: 10000, gstRatePct: 12 },
  ],
  [],
  { market: 'DOMESTIC', buyerState: 'Rajasthan', companyState: 'Rajasthan' }
);
check('one row per slab, lowest first', slabs.taxRows.map((t) => t.ratePct), [12, 18]);
check('each slab taxes only its own goods', slabs.taxRows.map((t) => t.taxable), [10000, 10000]);
check('and the tax adds up', slabs.taxTotal, 3000);
check('a zero-rated line is not a slab', documentTotals([{ qty: 1, unitPrice: 100, gstRatePct: 0 }], [], { market: 'DOMESTIC', buyerState: 'X', companyState: 'X' }).taxRows.length, 0);

console.log('\n--- a discount reduces the tax with it ---');
const discounted = documentTotals(
  [{ qty: 10, unitPrice: 1000, discountPct: 10, gstRatePct: 18 }],
  [{ kind: 'DISCOUNT', name: 'Dealer', pct: 5, gstRatePct: 18 }],
  { market: 'DOMESTIC', buyerState: 'Rajasthan', companyState: 'Rajasthan' }
);
check('the line discount lands in the subtotal', discounted.subtotal, 9000);
check('and is reported for the document to show', discounted.lineDiscount, 1000);
check('the document discount is a percentage of that subtotal', discounted.chargeTotal, -450);
check('tax is on what is actually payable', discounted.taxableValue, 8550);
check('so the buyer is not taxed on money they did not pay', discounted.taxTotal, 1539);
check('the total holds together', discounted.grandTotal, 10089);

console.log('\n--- a charge added after tax ---');
const afterTax = documentTotals(
  [{ qty: 1, unitPrice: 1000, gstRatePct: 18 }],
  [{ kind: 'CHARGE', name: 'Round off', amount: 0.4, isTaxable: false }],
  { market: 'DOMESTIC', buyerState: 'Rajasthan', companyState: 'Rajasthan' }
);
check('an untaxed charge stays out of the taxable value', afterTax.taxableValue, 1000);
check('but is still in the total', afterTax.grandTotal, 1180.4);
check('and is reported separately', afterTax.untaxedCharges, 0.4);

console.log('\n--- CGST and SGST always reconcile ---');
// Splitting an odd number of paise must not lose or invent one: the halves are derived
// from the rounded slab total, so they add back to it exactly.
for (const price of [333.33, 1010.1, 7777.77, 99999.99, 1, 0.01]) {
  const d = documentTotals([{ qty: 1, unitPrice: price, gstRatePct: 18 }], [], { market: 'DOMESTIC', buyerState: 'R', companyState: 'R' });
  check(`CGST + SGST equals the tax on Rs ${price}`, round(d.cgst + d.sgst), round(d.taxTotal));
  check(`and the total is value + tax at Rs ${price}`, round(d.grandTotal), round(d.taxableValue + d.taxTotal));
}

console.log('\n--- a discount bigger than the goods ---');
// An unclamped document total goes negative, and a negative order value lands in
// receivables where it silently offsets other buyers' real debts.
const overshot = documentTotals([{ qty: 1, unitPrice: 100, gstRatePct: 18 }], [{ kind: 'DISCOUNT', name: 'Fat finger', amount: 10000, gstRatePct: 18 }], {
  market: 'DOMESTIC',
  buyerState: 'R',
  companyState: 'R',
});
check('the taxable value is clamped at zero, not negative', overshot.taxableValue, 0);
check('so is the total', overshot.grandTotal, 0);
check('and it says the discount overshot', overshot.overDiscounted, true);
check('no tax is charged on nothing', overshot.taxTotal, 0);
check('an ordinary document does not claim it overshot', intra.overDiscounted, false);
// Same on an export, where there is no tax to hide behind.
check('an export total is clamped too', documentTotals([{ qty: 1, unitPrice: 100 }], [{ kind: 'DISCOUNT', name: 'x', amount: 500 }], { market: 'OVERSEAS' }).grandTotal, 0);

console.log('\n--- a charge taxed at a rate no line uses ---');
// 18% off 12% goods relieves more tax than the goods ever carried, and prints a negative
// slab. The maths is reported rather than silently accepted.
const mismatch = documentTotals([{ qty: 1, unitPrice: 10000, gstRatePct: 12 }], [{ kind: 'DISCOUNT', name: 'Dealer', amount: 1000, gstRatePct: 18 }], {
  market: 'DOMESTIC',
  buyerState: 'R',
  companyState: 'R',
});
check('the mismatched rate is named', mismatch.mismatchedChargeRates, [18]);
check('a matching rate is not flagged', documentTotals([{ qty: 1, unitPrice: 10000, gstRatePct: 12 }], [{ kind: 'DISCOUNT', name: 'Dealer', amount: 1000, gstRatePct: 12 }], { market: 'DOMESTIC', buyerState: 'R', companyState: 'R' }).mismatchedChargeRates, []);
check('nothing is flagged on a plain document', intra.mismatchedChargeRates, []);

console.log('\n--- what the rest of the app reads ---');
check('documentValue is the grand total', documentValue([{ qty: 2, unitPrice: 500, gstRatePct: 18 }], [], { market: 'DOMESTIC', buyerState: 'R', companyState: 'R' }), 1180);
check('an empty document is worth nothing, not NaN', documentValue([], [], { market: 'DOMESTIC', buyerState: 'R', companyState: 'R' }), 0);
check('overseas keeps the numbering it always had', docKeys('OVERSEAS'), { proforma: 'PI', order: 'ORD', invoice: 'INV' });
check('domestic gets its own series', docKeys('DOMESTIC'), { proforma: 'DPI', order: 'DORD', invoice: 'DINV' });
check('an unset market is treated as overseas', docKeys(null), { proforma: 'PI', order: 'ORD', invoice: 'INV' });

console.log('\n--- the state comparison behind the split ---');
check('spacing and case do not make a new state', sameState('  rajasthan ', 'Rajasthan'), true);
check('two different states are different', sameState('Gujarat', 'Rajasthan'), false);
// Unknown against unknown must NOT count as intra-state, or a buyer with no address on
// file would silently be charged CGST+SGST on an inter-state sale.
check('an unknown state never counts as a match', sameState(null, null), false);
check('nor does an empty one', sameState('', 'Rajasthan'), false);

// ---------------------------------------------------------------------------
// The pricing engine is mirrored on the client — prove it, don't hope
// ---------------------------------------------------------------------------
//
// costing.ts and expr.ts are mirrored by hand and read differently on each side, so they
// cannot be compared mechanically. pricing.ts WAS written as a byte-exact copy below its
// header, which makes drift checkable — and drift there would mean the live total shown
// while editing a quote disagrees with the one the API goes on to store.
// ---------------------------------------------------------------------------
// Soft delete is a QUERY-layer concern
// ---------------------------------------------------------------------------
//
// The pure engines must stay ignorant of it. These checks pin that down: pass a
// soft-deleted order to the finance engine and it is still priced — because excluding it
// is the CALLER's job, exactly as excluding a cancelled one is. If someone ever "helpfully"
// teaches buildFinanceContext about deletedAt, these fail and say why.
console.log('\n--- soft delete stays out of the pure functions ---');
{
  const mkOrder = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    number: `ORD-${id}`,
    buyerId: 1,
    status: 'Confirmed',
    orderDate: new Date(2026, 0, 10),
    exchangeRate: 1,
    currency: { code: 'INR', symbol: '₹' },
    lines: [{ qty: 1, unitPrice: 1000 }],
    ...extra,
  });
  const noJobwork = new Map<number, Map<number, number>>();

  const live = buildFinanceContext([mkOrder(1)] as never, [], noJobwork);
  check('an ordinary order is priced', live.received.get(1) ?? 0, 0);

  // A cancelled order drops out inside the engine (a documented behaviour)…
  const cancelled = buildFinanceContext([mkOrder(2, { status: 'Cancelled' })] as never, [{ id: 1, partyType: 'BUYER', kind: 'PAYMENT', amount: 400, currency: 'INR', date: new Date(2026, 0, 11), buyerId: 1, partyName: 'B' }] as never, noJobwork);
  check('a cancelled order takes no receipt', cancelled.received.get(2) ?? 0, 0);

  // …but a soft-deleted one does NOT: the engine has no idea, and must not.
  const deleted = buildFinanceContext(
    [mkOrder(3, { deletedAt: new Date() })] as never,
    [{ id: 1, partyType: 'BUYER', kind: 'PAYMENT', amount: 400, currency: 'INR', date: new Date(2026, 0, 11), buyerId: 1, partyName: 'B' }] as never,
    noJobwork
  );
  check('the engine does NOT special-case a deleted order — the query must exclude it', deleted.received.get(3), 400);
}

// ---------------------------------------------------------------------------
// Cartons, space, weight — and what may still go out
// ---------------------------------------------------------------------------

console.log('\n--- cartons and volume ---');
{
  check('24 pcs at 4 per carton is 6 full boxes', cartonsFor(24, 4), { full: 6, lastPieces: 0, total: 6 });
  // A part carton is still a carton — six full boxes plus one holding a single piece.
  check('25 pcs at 4 leaves a short last box', cartonsFor(25, 4), { full: 6, lastPieces: 1, total: 7 });
  check('a missing pieces-per-carton means loose pieces, never a divide by zero', cartonsFor(5, null), { full: 5, lastPieces: 0, total: 5 });
  check('zero is handled the same way', cartonsFor(5, 0), { full: 5, lastPieces: 0, total: 5 });
  check('nothing to pack is no cartons', cartonsFor(0, 4), { full: 0, lastPieces: 0, total: 0 });

  // A product as the wizard builds one: volumeAfterPackingCbm is PER PIECE.
  const dims = { packLengthIn: 24, packWidthIn: 18, packHeightIn: 12, piecesPerCarton: 4 };
  const boxCbm = round4(24 * 18 * 12 * CBM_PER_CUBIC_INCH);
  const perPiece = round4(boxCbm / 4);
  check('the box volume comes off the dimensions', cartonBoxCbm(dims), boxCbm);
  /**
   * THE property that catches a future refactor of the wizard: the stored per-piece figure
   * times the pieces per carton is the whole box. Get the direction wrong and every load
   * under-reports by a factor of `piecesPerCarton`.
   *
   * It reconciles to within 4-dp ROUNDING, not exactly, and that is by construction: the
   * wizard stores a rounded per-piece figure, so multiplying it back can be out by up to
   * half a unit in the last place per piece. That is precisely the drift `CBM_MISMATCH_PCT`
   * is set at 1% to absorb — an exact-equality check here would be asserting something the
   * data cannot deliver.
   */
  check('per-piece × pieces-per-carton is the whole box, to within rounding', Math.abs(perPiece * 4 - boxCbm) <= 4 * 0.00005, true);
  check('and it is the right order of magnitude — not out by piecesPerCarton', Math.abs(perPiece * 4 - boxCbm) < boxCbm / 2, true);

  const stored = cartonCbm({ ...dims, cbmPerPiece: perPiece });
  check('a stored per-piece figure is scaled to the carton', stored.value, round4(perPiece * 4));
  check('and is reported as coming from the product', stored.source, 'STORED');
  // The rounding drift is real but far below the threshold worth telling a packer about.
  check('the rounding drift is not flagged as a disagreement', stored.mismatchPct <= CBM_MISMATCH_PCT, true);

  // Clearing cbmPerPiece is how a caller hands authority to the dimensions.
  const derived = cartonCbm({ ...dims, cbmPerPiece: null });
  check('clearing the stored figure hands over to the dimensions', [derived.value, derived.source], [boxCbm, 'DERIVED']);

  // A measurement outranks arithmetic.
  const override = cartonCbm({ ...dims, cbmPerPiece: perPiece, cbmPerCartonOverride: 0.9 });
  check('a measured box wins outright', [override.value, override.source], [0.9, 'OVERRIDE']);

  // A disagreement is REPORTED, never resolved silently.
  const off = cartonCbm({ ...dims, cbmPerPiece: round4(perPiece * 1.03) });
  check('a 3% disagreement is flagged', off.mismatchPct > CBM_MISMATCH_PCT, true);
  const rounding = cartonCbm({ ...dims, cbmPerPiece: round4(perPiece * 1.002) });
  check('a rounding difference is not', rounding.mismatchPct <= CBM_MISMATCH_PCT, true);

  // A part carton is a whole box for volume, pro-rata for weight.
  const batch = { ...dims, cbmPerPiece: perPiece, netWeightKg: 10, grossWeightKg: 12, qty: 25, cartonCount: 7 };
  const oneBox = round4(perPiece * 4);
  const full = packedTotals([batch]);
  check('seven boxes take seven boxes of room', full.cbm, round4(oneBox * 7));
  check('but only 25 pieces of weight', [full.netKg, full.grossKg], [250, 300]);
  const part = packedTotals([{ ...batch, cartonsTaken: 1, piecesTaken: 1 }]);
  check('a single short carton still occupies a full box', part.cbm, oneBox);
  check('and weighs only what is in it', part.grossKg, 12);
}

console.log('\n--- containers ---');
{
  const twenty = { capacityCbm: 33, payloadKg: 21000 };
  const load = { cartons: 10, pieces: 40, cbm: 30, netKg: 17000, grossKg: 18000 };
  const fit = containerFit(load, twenty);
  check('a load that fits reports so', [fit.fits, fit.overCbm, fit.overKg], [true, false, false]);
  check('and how full it is', [fit.cbmPct, fit.kgPct], [90.91, 85.71]);

  check('over on volume alone does not fit', containerFit({ ...load, cbm: 34 }, twenty).fits, false);
  check('over on payload alone does not fit', containerFit({ ...load, grossKg: 22000 }, twenty).fits, false);
  // The limit is on what crosses a weighbridge, so the empty box counts against it.
  check('tare weight counts against the payload', containerFit({ ...load, grossKg: 20000 }, twenty, 2200).overKg, true);
  check('and is included in the figure declared', containerFit({ ...load, grossKg: 20000 }, twenty, 2200).usedKg, 22200);

  // A capacity of 0 means "not a container" — an LCL part load has no limit to exceed.
  const lcl = containerFit({ ...load, cbm: 999, grossKg: 99999 }, { capacityCbm: 0, payloadKg: 0 });
  check('a part load can never be over capacity', [lcl.fits, lcl.cbmPct, lcl.kgPct], [true, 0, 0]);

  check('VGM is the tare plus what went in', vgm(2200, 18000), 20200);
  check('and treats a missing tare as nothing', vgm(null, 18000), 18000);

  const types = [
    { id: 1, code: '20FT', capacityCbm: 33, payloadKg: 21000 },
    { id: 3, code: '40HQ', capacityCbm: 76, payloadKg: 26500 },
  ];
  const cartons = Array.from({ length: 100 }, () => ({ cbm: 1, grossKg: 100 }));
  const plan = planContainers(cartons, types);
  check('a 100 CBM load needs two of the biggest box', plan.length, 2);
  check('and every proposed box fits', plan.every((p) => p.fit.fits), true);
  check('nothing to load needs no container', planContainers([], types).length, 0);
  // A box with no stated capacity would swallow everything and report a perfect fit.
  check('a part-load type is never proposed', planContainers(cartons, [{ id: 4, code: 'LCL', capacityCbm: 0, payloadKg: 0 }]).length, 0);
}

console.log('\n--- what may still go out ---');
{
  check('nothing packed means nothing to ship', guardShipQty(0, 1), 'Nothing is packed and ready for this line yet.');
  check('more than is packed is refused, and says how many', guardShipQty(4, 5), 'Only 4 pc(s) are packed and unshipped on this line.');
  check('exactly what is packed is allowed', guardShipQty(4, 4), null);
  check('pieces ship whole', guardShipQty(4, 1.5), 'Pieces ship whole.');
  check('nothing finished means nothing to pack', guardPackQty(0, 1), 'Nothing is finished and unpacked on this line yet.');
  check('a legal pack passes', guardPackQty(10, 10), null);

  // An order shipped in parts: 40 then 60 of 100 both pass, and a further 1 does not.
  check('the first part shipment is allowed', guardShipQty(100, 40), null);
  check('and so is the rest', guardShipQty(60, 60), null);
  check('but not one more', guardShipQty(0, 1), 'Nothing is packed and ready for this line yet.');

  check('nothing shipped cannot be billed', guardInvoiceQty(0, 0, 1), 'This line has not shipped yet, so there is nothing to bill.');
  check('billing what shipped is allowed', guardInvoiceQty(10, 0, 10), null);
  check('billing it twice is refused', guardInvoiceQty(10, 10, 1), 'All 10 shipped pc(s) on this line are already invoiced.');
  check('and a part-billed line says what is left', guardInvoiceQty(10, 6, 5), 'Only 4 of the 10 shipped pc(s) are still to be invoiced.');
  check('a carton cannot hold more than it holds', guardCartonFit(2, 4, 9), '2 carton(s) of 4 hold at most 8 pc — not 9.');
  check('and a legal fit passes', guardCartonFit(2, 4, 8), null);
}

console.log('\n--- finished stock is derived, never stored ---');
{
  const base = { boardDone: [], txns: [], boughtIn: [], packed: [], shipped: [] };
  const line = { orderLineId: 7, productId: 3, done: 40, ordered: 40 };

  const board = finishedOnHand({ ...base, boardDone: [line] });
  check('the board alone puts pieces on the floor', board.byOrderLine.get(7)!.onHand, 40);
  check('all of it is packable', board.byOrderLine.get(7)!.availableToPack, 40);
  // availableToShip counts PACKED and unshipped — shipping what was never packed is
  // exactly what the pack step exists to prevent.
  check('but none of it is shippable until it is boxed', board.byOrderLine.get(7)!.availableToShip, 0);

  const packed = finishedOnHand({ ...base, boardDone: [line], packed: [{ productId: 3, orderLineId: 7, qty: 24 }] });
  const cell = packed.byOrderLine.get(7)!;
  check('packing does not change what is on hand', cell.onHand, 40);
  check('it moves pieces from packable to shippable', [cell.availableToPack, cell.availableToShip], [16, 24]);

  const shipped = finishedOnHand({
    ...base,
    boardDone: [line],
    packed: [{ productId: 3, orderLineId: 7, qty: 24 }],
    shipped: [{ productId: 3, orderLineId: 7, qty: 24 }],
  });
  check('shipping takes them off the floor', shipped.byOrderLine.get(7)!.onHand, 16);
  check('and there is nothing boxed left to send', shipped.byOrderLine.get(7)!.availableToShip, 0);

  // THE conservation identity.
  const mixed = finishedOnHand({
    boardDone: [line],
    txns: [
      { productId: 3, orderLineId: 7, kind: 'ADJUST_OUT', qty: 2 },
      { productId: 3, orderLineId: null, kind: 'ADJUST_IN', qty: 5 },
      { productId: 3, orderLineId: null, kind: 'RETURN_IN', qty: 1 },
    ],
    boughtIn: [{ productId: 3, qty: 10 }],
    packed: [],
    shipped: [{ productId: 3, orderLineId: 7, qty: 3 }],
  });
  const p = mixed.byProduct.get(3)!;
  check('board + adjustments + bought-in + returns − shipped is what is on hand', p.boardDone + p.adjusted + p.boughtIn + p.returned - p.shipped, p.onHand);
  check('and the order-linked part plus the free pool is the whole', (mixed.byOrderLine.get(7)!.onHand ?? 0) + (mixed.freePool.get(3)!.onHand ?? 0), p.onHand);
  // Bought-in goods and returns belong to no order, by definition.
  check('bought-in stock is free pool', mixed.freePool.get(3)!.boughtIn, 10);
  check('an order-linked adjustment is not', mixed.byOrderLine.get(7)!.adjusted, -2);

  // Undoing a completion un-does the stock, because the board is read live.
  const undone = finishedOnHand({ ...base, boardDone: [{ ...line, done: 0 }] });
  check('undoing a completion un-does the stock', undone.byOrderLine.get(7)!.onHand, 0);

  // Over-production is recognisable, and is free for any order to draw on.
  const over = finishedOnHand({ ...base, boardDone: [{ ...line, done: 45 }] });
  check('pieces made beyond the order are named as over-production', over.byOrderLine.get(7)!.overProduced, 5);

  // An unknown kind must not silently count as a receipt.
  const junk = finishedOnHand({ ...base, boardDone: [line], txns: [{ productId: 3, orderLineId: 7, kind: 'NONSENSE', qty: 999 }] });
  check('an unrecognised movement is ignored, not trusted', junk.byOrderLine.get(7)!.onHand, 40);
}

console.log('\n--- Shipped is derived from the dispatches ---');
{
  const summary = { ordered: 70, done: 70, wip: 0, pending: 0 };
  // A board-only caller must behave exactly as it always did.
  check('without a shipped figure the board rule is unchanged', impliedOrderStatus('Production', summary), 'Ready');
  check('a partly shipped order stays where the board put it', impliedOrderStatus('Ready', summary, 24), null);
  check('fully shipped becomes Shipped', impliedOrderStatus('Ready', summary, 70), 'Shipped');
  check('over-shipping still counts as shipped', impliedOrderStatus('Ready', summary, 71), 'Shipped');
  check('already Shipped needs no change', impliedOrderStatus('Shipped', summary, 70), null);
  // Un-shipping it (deleting the dispatch) is the only thing that pulls it back.
  check('un-shipping restates it', impliedOrderStatus('Shipped', summary, 0), 'Ready');
  // Closed and Cancelled remain human decisions and are never touched.
  check('Closed is never moved', impliedOrderStatus('Closed', summary, 70), null);
  check('nor is Cancelled', impliedOrderStatus('Cancelled', summary, 70), null);
  check('a board-only caller cannot un-ship an order by omission', impliedOrderStatus('Shipped', summary), null);
}

// ---------------------------------------------------------------------------
// The receivable basis — ORDER (default) versus INVOICE
// ---------------------------------------------------------------------------
//
// Switching the basis restates every balance on the next read, because allocation is a
// pure function recomputed on every request. Two things have to hold or the order page and
// the Payments page start disagreeing:
//
//   1. ORDER must behave EXACTLY as it always did — the default cannot move.
//   2. Under INVOICE, an invoice may span several orders, so the money settled against it
//      has to split back across them and the parts must sum to the whole EXACTLY.
console.log('\n--- the receivable basis ---');
{
  const buyer = { market: 'OVERSEAS', state: null };
  const ccy = { code: 'INR', symbol: '₹' };
  const order = (id: number, qty: number, price: number) => ({
    id,
    number: `ORD-${id}`,
    buyerId: 1,
    status: 'Confirmed',
    orderDate: new Date(2026, 0, 10 + id),
    exchangeRate: 1,
    currency: ccy,
    buyer,
    lines: [{ qty, unitPrice: price }],
  });
  const receipt = (id: number, amount: number, extra: Record<string, unknown> = {}) => ({
    id,
    partyType: 'BUYER',
    kind: 'PAYMENT',
    amount,
    currency: 'INR',
    date: new Date(2026, 1, id),
    buyerId: 1,
    partyName: 'Buyer',
    ...extra,
  });
  const noJobwork = new Map<number, Map<number, number>>();
  const orders = [order(1, 10, 100), order(2, 10, 300)] as never; // worth 1000 and 3000

  // --- the default is unchanged --------------------------------------------
  const byOrder = buildFinanceContext(orders, [receipt(1, 1500)] as never, noJobwork, null);
  check('the default basis is ORDER', byOrder.basis, 'ORDER');
  check('ORDER: the oldest order settles first, then the surplus rolls on', [byOrder.received.get(1), byOrder.received.get(2)], [1000, 500]);
  // The order IS the debt here, so reporting it as "not yet billed" as well would let a page
  // show the same money twice. The map stays empty rather than being gated by every reader.
  check('ORDER: order book is empty, because the order IS the debt', byOrder.orderBook.size, 0);

  // --- one invoice covering ONE order --------------------------------------
  const inv = (id: number, lines: { qty: number; unitPrice: number; orderId: number }[], extra: Record<string, unknown> = {}) => ({
    id,
    number: `INV-${id}`,
    buyerId: 1,
    status: 'ISSUED',
    invoiceDate: new Date(2026, 0, 20 + id),
    exchangeRate: 1,
    currency: ccy,
    buyer,
    lines,
    ...extra,
  });

  const single = buildFinanceContext(orders, [receipt(1, 600)] as never, noJobwork, null, {
    basis: 'INVOICE',
    invoices: [inv(1, [{ qty: 10, unitPrice: 100, orderId: 1 }])] as never,
  });
  check('INVOICE: the basis is carried on the context', single.basis, 'INVOICE');
  check('INVOICE: the invoice is what got settled', single.invoiceReceived.get(1), 600);
  check('INVOICE: a single-order invoice attributes straight through', single.received.get(1), 600);
  check('INVOICE: an uninvoiced order is order book, not a receivable', single.orderBook.get(2), 3000);
  check('INVOICE: an invoiced order has no order book left', single.orderBook.get(1), 0);

  // --- one invoice spanning TWO orders -------------------------------------
  // Lines worth 1000 (order 1) and 3000 (order 2); a 2000 receipt is split 25/75.
  const spanning = buildFinanceContext(orders, [receipt(1, 2000)] as never, noJobwork, null, {
    basis: 'INVOICE',
    invoices: [
      inv(1, [
        { qty: 10, unitPrice: 100, orderId: 1 },
        { qty: 10, unitPrice: 300, orderId: 2 },
      ]),
    ] as never,
  });
  check('INVOICE: a spanning invoice is ONE debt', spanning.invoiceReceived.get(1), 2000);
  check('INVOICE: the split is weighted by what each order is worth', [spanning.received.get(1), spanning.received.get(2)], [500, 1500]);
  check(
    'INVOICE: the attribution sums to exactly what was settled',
    round((spanning.received.get(1) ?? 0) + (spanning.received.get(2) ?? 0)),
    spanning.invoiceReceived.get(1)
  );

  // A third of an odd amount cannot divide cleanly — the remainder must not vanish.
  const odd = buildFinanceContext(orders, [receipt(1, 1000.01)] as never, noJobwork, null, {
    basis: 'INVOICE',
    invoices: [
      inv(1, [
        { qty: 1, unitPrice: 1, orderId: 1 },
        { qty: 1, unitPrice: 1, orderId: 2 },
        { qty: 1, unitPrice: 1, orderId: 1 },
      ]),
    ] as never,
  });
  check(
    'INVOICE: an indivisible split still reconciles to the paisa',
    round((odd.received.get(1) ?? 0) + (odd.received.get(2) ?? 0)),
    odd.invoiceReceived.get(1)
  );

  // --- a cancelled invoice stops being a debt, as a cancelled order does ---
  const cancelledInv = buildFinanceContext(orders, [receipt(1, 500)] as never, noJobwork, null, {
    basis: 'INVOICE',
    invoices: [inv(1, [{ qty: 10, unitPrice: 100, orderId: 1 }], { status: 'CANCELLED' })] as never,
  });
  check('INVOICE: a cancelled invoice takes no receipt', cancelledInv.invoiceReceived.get(1) ?? 0, 0);
  check('INVOICE: with nothing to settle the money is credit on account', cancelledInv.buyerCredit.get('1:INR')?.amount, 500);

  // A DRAFT has not been sent to anybody. It must be neither a debt nor a reduction of the
  // order book, or a receivable would appear the moment somebody started typing an invoice.
  const draft = buildFinanceContext(orders, [receipt(1, 500)] as never, noJobwork, null, {
    basis: 'INVOICE',
    invoices: [inv(1, [{ qty: 10, unitPrice: 100, orderId: 1 }], { status: 'DRAFT' })] as never,
  });
  check('INVOICE: a draft invoice is not yet a debt', draft.invoiceReceived.get(1) ?? 0, 0);
  check('INVOICE: a draft does not reduce the order book either', draft.orderBook.get(1), 1000);

  // A receipt recorded against an invoice ALSO carries the order it was raised against.
  // Flipping the basis back to ORDER must still honour that order aim rather than dropping
  // it and re-spreading the money oldest-first.
  const bothAims = buildFinanceContext(orders, [receipt(1, 400, { invoiceId: 9, orderId: 2 })] as never, noJobwork, null);
  check('ORDER: a receipt naming an absent invoice still honours its order', [bothAims.received.get(1), bothAims.received.get(2)], [0, 400]);

  // --- a payment that NAMES its invoice is honoured over age ---------------
  const aimed = buildFinanceContext(orders, [receipt(1, 500, { invoiceId: 2 })] as never, noJobwork, null, {
    basis: 'INVOICE',
    invoices: [inv(1, [{ qty: 10, unitPrice: 100, orderId: 1 }]), inv(2, [{ qty: 10, unitPrice: 300, orderId: 2 }])] as never,
  });
  check('INVOICE: a receipt naming an invoice settles that one first', [aimed.invoiceReceived.get(1), aimed.invoiceReceived.get(2)], [0, 500]);
}

// ---------------------------------------------------------------------------
// Scheduling — an overlay on the board, never a replacement
// ---------------------------------------------------------------------------

console.log('\n--- auto-scheduling from stage durations ---');
{
  const steps = [
    { orderLineStageId: 1, name: 'Raw joining', sortOrder: 0, defaultDays: 4 },
    { orderLineStageId: 2, name: 'Raw sanding', sortOrder: 1, defaultDays: 2 },
    { orderLineStageId: 3, name: 'Polishing', sortOrder: 2, defaultDays: 3 },
    { orderLineStageId: 4, name: 'QC', sortOrder: 3, defaultDays: 1 },
  ];
  const start = new Date(2026, 7, 3); // 3 Aug
  const plan = autoSchedule(steps, start, new Date(2026, 7, 13)); // 10-day window, 10 stated
  check('every stage is scheduled', plan.length, 4);
  check('the first starts on the start date', dayKey(plan[0].estimatedStart), '2026-08-03');
  // A 4-day stage starting on the 3rd ends on the 6th: inclusive of both days.
  check('a 4-day stage is 4 calendar days, inclusive', dayKey(plan[0].estimatedEnd), '2026-08-06');
  check('the next starts the day after', dayKey(plan[1].estimatedStart), '2026-08-07');
  check('stages never overlap', plan.every((s, i) => i === 0 || daysBetween(plan[i - 1].estimatedEnd, s.estimatedStart) === 1), true);
  check('the stated durations are honoured', plan.map((s) => daysBetween(s.estimatedStart, s.estimatedEnd) + 1), [4, 2, 3, 1]);

  // Steps with no duration share what is left.
  const mixed = autoSchedule(
    [
      { orderLineStageId: 1, name: 'A', sortOrder: 0, defaultDays: 6 },
      { orderLineStageId: 2, name: 'B', sortOrder: 1, defaultDays: null },
      { orderLineStageId: 3, name: 'C', sortOrder: 2, defaultDays: null },
    ],
    start,
    new Date(2026, 7, 15) // 12 days, 6 stated, 6 to share
  );
  check('an unstated step takes an equal share of what is left', mixed.slice(1).map((s) => daysBetween(s.estimatedStart, s.estimatedEnd) + 1), [3, 3]);

  // Durations that do not fit are scaled, not allowed to overrun the deadline.
  const tight = autoSchedule(steps, start, new Date(2026, 7, 7)); // 4 days for 10 days of work
  check('a window too short scales the stages down', tight.length, 4);
  check('and every stage still gets at least a day', tight.every((s) => daysBetween(s.estimatedStart, s.estimatedEnd) >= 0), true);
  check('nothing is scheduled before the start', dayKey(tight[0].estimatedStart), '2026-08-03');
  check('no stages, no schedule', autoSchedule([], start, new Date(2026, 7, 13)), []);
}

console.log('\n--- schedule versus what the board shows ---');
{
  const at = (id: number, name: string, sortOrder: number, end: Date | null, atNow: number, cleared: number) => ({
    orderLineStageId: id,
    name,
    sortOrder,
    estimatedStart: null,
    estimatedEnd: end,
    at: atNow,
    cleared,
  });
  const today = new Date(2026, 7, 10);
  const est = estimateCompletion(
    10,
    [
      at(1, 'Joining', 0, new Date(2026, 7, 5), 0, 10), // finished, was due the 5th
      at(2, 'Polishing', 1, new Date(2026, 7, 8), 4, 0), // pieces sitting here, overdue
      at(3, 'QC', 2, new Date(2026, 7, 14), 0, 0), // not started, not due yet
    ],
    today
  );
  check('a finished stage reads DONE', est.stages[0].status, 'DONE');
  check('a stage past its date with pieces still on it is OVERDUE', est.stages[1].status, 'OVERDUE');
  check('and says by how many days', est.stages[1].daysOverdue, 2);
  check('a future stage with nothing on it is NOT_STARTED', est.stages[2].status, 'NOT_STARTED');
  check('the overall verdict is behind', est.isBehind, true);
  check('and reports the worst slippage', est.daysLate, 2);
  check('the estimated finish is the last stage end', dayKey(est.estimatedCompletion!), '2026-08-14');
  // Progress comes from the BOARD, not the schedule — nothing has cleared the last stage.
  check('progress is what the board says, not what was planned', est.percentComplete, 0);

  const early = estimateCompletion(10, [at(1, 'Joining', 0, new Date(2026, 7, 20), 0, 10)], today);
  check('finishing before the date reads AHEAD', early.stages[0].status, 'AHEAD');
  check('and is not behind', early.isBehind, false);
  check('an unscheduled stage has no remaining days', estimateCompletion(10, [at(1, 'X', 0, null, 0, 0)], today).stages[0].daysRemaining, null);
}

console.log('\n--- a plan must never end after its deadline ---');
{
  // Five stages rounding to zero each get clamped to one day, which used to push the plan
  // past the date it was generated from — and `deliveryStatus` then called the same order
  // LATE in the very same response.
  const steps = [30, 1, 1, 1, 1, 1].map((d, i) => ({ orderLineStageId: i + 1, name: 'S' + i, sortOrder: i, defaultDays: d }));
  const from = new Date(2026, 6, 1);
  const to = new Date(2026, 6, 20);
  const plan = autoSchedule(steps, from, to);
  check('the plan ends on or before the deadline', daysBetween(plan[plan.length - 1].estimatedEnd, to) >= 0, true);
  check('and still schedules every stage', plan.length, 6);
  check('each stage keeps at least a day', plan.every((p) => daysBetween(p.estimatedStart, p.estimatedEnd) >= 0), true);

  // A window genuinely too small for one day per stage cannot fit, and must not pretend to.
  const impossible = autoSchedule(steps, from, new Date(2026, 6, 3));
  check('an impossible window still yields one day per stage', impossible.length, 6);
  check('and starts where it was told to', dayKey(impossible[0].estimatedStart), '2026-07-01');
}

console.log('\n--- pieces still on a stage mean it is not done ---');
{
  // Rework makes `cleared` exceed `qty` legitimately, so testing cleared alone called a
  // stage finished while two pieces sat on it nineteen days past its date.
  const st = (at: number, cleared: number) => [{ orderLineStageId: 1, name: 'Polishing', sortOrder: 0, estimatedStart: null, estimatedEnd: new Date(2026, 6, 10), at, cleared }];
  const stuck = estimateCompletion(10, st(2, 12), new Date(2026, 6, 29));
  check('a stage with pieces on it past its date is OVERDUE, not DONE', stuck.stages[0].status, 'OVERDUE');
  check('and the line reports it is behind', stuck.isBehind, true);
  check('with the days counted', stuck.stages[0].daysOverdue, 19);
  check('an empty stage everything has passed is DONE', estimateCompletion(10, st(0, 12), new Date(2026, 6, 29)).stages[0].status, 'DONE');
  // Progress is the board's `done`, so it agrees with the delivery verdict beside it.
  check('progress comes from the board, not the last stage', estimateCompletion(10, st(0, 12), new Date(2026, 6, 29), 5).percentComplete, 50);
}

console.log('\n--- delivery status ---');
{
  const today = new Date(2026, 7, 10);
  const d = (o: Parameters<typeof deliveryStatus>[0]) => deliveryStatus(o, today);
  check('a shipped order is delivered', d({ status: 'Shipped', deliveryDate: new Date(2026, 7, 1), qty: 10, done: 10 }).status, 'DELIVERED');
  check('even if it shipped before everything was done', d({ status: 'Closed', deliveryDate: new Date(2026, 7, 1), qty: 10, done: 4 }).percentComplete, 100);
  check('past the date and unfinished is LATE', d({ status: 'Production', deliveryDate: new Date(2026, 7, 5), qty: 10, done: 6 }).status, 'LATE');
  check('and counts the days', d({ status: 'Production', deliveryDate: new Date(2026, 7, 5), qty: 10, done: 6 }).daysLate, 5);
  check('all pieces done is on track whatever the date', d({ status: 'Production', deliveryDate: new Date(2026, 7, 12), qty: 10, done: 10 }).status, 'ON_TRACK');
  check('a week out and barely started is AT_RISK', d({ status: 'Production', deliveryDate: new Date(2026, 7, 15), qty: 10, done: 2 }).status, 'AT_RISK');
  check('a week out and nearly done is fine', d({ status: 'Production', deliveryDate: new Date(2026, 7, 15), qty: 10, done: 9 }).status, 'ON_TRACK');
  // Far out, a slow start is normal and must not cry wolf.
  check('a month out and barely started is not yet a problem', d({ status: 'Confirmed', deliveryDate: new Date(2026, 8, 20), qty: 10, done: 0 }).status, 'ON_TRACK');
  check('due today and unfinished is AT_RISK', d({ status: 'Production', deliveryDate: today, qty: 10, done: 5 }).status, 'AT_RISK');
  check('no date means no verdict', d({ status: 'Confirmed', qty: 10, done: 0 }).status, 'NO_DATE');
  check('a cancelled order is not chased', d({ status: 'Cancelled', deliveryDate: new Date(2026, 7, 1), qty: 10, done: 0 }).status, 'NO_DATE');
  check('the urgent sort puts late first', (['ON_TRACK', 'LATE', 'DELIVERED', 'AT_RISK'] as const).slice().sort((a, b) => DELIVERY_URGENCY[a] - DELIVERY_URGENCY[b]), ['LATE', 'AT_RISK', 'ON_TRACK', 'DELIVERED']);
}

// ---------------------------------------------------------------------------
// Multi-currency receivables and the forex position
// ---------------------------------------------------------------------------

console.log('\n--- receivables grouped by currency ---');
{
  const sym = (c: string) => (({ USD: '$', GBP: '£', INR: '₹' }) as Record<string, string>)[c] ?? '';
  const row = (orderId: number, currency: string, receivableFcy: number, snapshotRate: number, currentRate: number) => ({
    orderId,
    currency,
    invoicedFcy: receivableFcy,
    receivedFcy: 0,
    receivableFcy,
    snapshotRate,
    currentRate,
    receivableInr: round(receivableFcy * snapshotRate),
    receivableAtCurrentRate: round(receivableFcy * currentRate),
    forexGainLoss: round(receivableFcy * currentRate - receivableFcy * snapshotRate),
  });

  // Two USD orders booked at different rates, plus a rupee one.
  const fx = receivablesByCurrency([row(1, 'USD', 10000, 83, 84.5), row(2, 'USD', 5000, 82, 84.5), row(3, 'INR', 50000, 1, 1)], sym);
  check('one row per currency, biggest exposure first', fx.byCurrency.map((c) => c.currency), ['USD', 'INR']);
  const usd = fx.byCurrency[0];
  check('the foreign totals add up', usd.totalFcy, 15000);
  check('valued at the rates the orders were booked at', usd.totalInrAtSnapshot, 10000 * 83 + 5000 * 82);
  check('and at the live rate', usd.totalInrAtCurrent, 15000 * 84.5);
  check('the gain is the difference', usd.forexGainLoss, round(15000 * 84.5 - (10000 * 83 + 5000 * 82)));
  // Weighted by exposure, so the large order pulls the average toward its own rate.
  check('the average booked rate is weighted by what is outstanding', usd.averageSnapshotRate, round((10000 * 83 + 5000 * 82) / 15000, 4));
  check('and it sits between the two rates', usd.averageSnapshotRate > 82 && usd.averageSnapshotRate < 83, true);
  check('both orders are counted', usd.orderCount, 2);

  check('rupees can never show a gain or a loss', fx.byCurrency[1].forexGainLoss, 0);
  check('the net is the sum across currencies', fx.netForexGainLoss, round(usd.forexGainLoss));
  check('and foreign exposure is flagged', fx.hasForeignExposure, true);

  // A weakening foreign currency is a loss, and must read negative.
  check('a weaker currency is a loss', receivablesByCurrency([row(1, 'GBP', 1000, 106, 104)], sym).byCurrency[0].forexGainLoss, -2000);

  // A settled order is not exposure.
  check('a settled order is not outstanding', receivablesByCurrency([row(1, 'USD', 0, 83, 90)], sym).byCurrency.length, 0);
  check('nothing outstanding means no exposure', receivablesByCurrency([], sym).hasForeignExposure, false);
  check('rupees alone is not foreign exposure', receivablesByCurrency([row(1, 'INR', 5000, 1, 1)], sym).hasForeignExposure, false);

  // One nonsense rate must not take every other currency with it. Rates come from a
  // human pasting the ICEGATE table, and `round()` passes NaN straight through, so a
  // single bad parse would otherwise turn the entire net position into NaN.
  const poisoned = receivablesByCurrency([{ ...row(1, 'USD', 100, 83, 84.5), snapshotRate: NaN, receivableInr: NaN }, row(2, 'GBP', 1000, 105, 106)], sym);
  check('a broken rate does not poison the net figure', Number.isFinite(poisoned.netForexGainLoss), true);
  check('the healthy currency still reports correctly', poisoned.byCurrency.find((c) => c.currency === 'GBP')!.forexGainLoss, 1000);
  check('and every total stays a real number', poisoned.byCurrency.every((c) => Number.isFinite(c.totalInrAtSnapshot) && Number.isFinite(c.averageSnapshotRate)), true);
  check('an infinite rate is handled the same way', Number.isFinite(receivablesByCurrency([{ ...row(1, 'USD', 100, 83, 84.5), currentRate: Infinity, receivableAtCurrentRate: Infinity }], sym).netForexGainLoss), true);
}

console.log('\n--- what survives a wipe ---');
{
  // `db:clean` keeps the Company row as configuration, so deleting its logo file would
  // leave `logoFilename` pointing at nothing and every document would print a broken
  // letterhead. Everything whose owning row IS wiped must go with it.
  check('the company logo survives, because its record does', survivesWipe('company-logo-1753800000-abc12345.png'), true);
  check('and whatever case it was saved in', survivesWipe('Company-Logo-1.PNG'), true);
  check('.gitkeep survives so the folder does', survivesWipe('.gitkeep'), true);
  check('a product image does not', survivesWipe('demo-ab-2101-aurora-two-tone-sideboard.jpg'), false);
  check('nor a hand-over photo', survivesWipe('move-demo-1-jaipur-tiled-sideboard.jpg'), false);
  check('nor a worker document', survivesWipe('worker-1753800000-abc12345.jpg'), false);
  check('nor an order attachment', survivesWipe('order-1753800000-abc12345.pdf'), false);
  // A file merely mentioning the word must not slip through on a partial match.
  check('a name that only contains the prefix later is not kept', survivesWipe('order-company-logo-sneaky.pdf'), false);
}

console.log('\n--- the client mirrors ---');
{
  /**
   * Each pair is one engine that exists twice: once for the API and once so the UI can
   * answer the same question as you type. Everything from `from` to the end of the file
   * must match byte for byte — the header comments above the marker are allowed to differ,
   * because they address different readers.
   *
   * Add a pair here whenever you add a mirrored engine, or nothing stops it drifting.
   */
  const PAIRS = [
    { name: 'pricing', server: 'server/src/lib/pricing.ts', client: 'client/src/util/pricing.ts', from: 'export const MARKETS' },
    { name: 'shipping', server: 'server/src/lib/shipping.ts', client: 'client/src/util/shipping.ts', from: 'export const INCOTERMS' },
  ];

  const body = (file: string, from: string): string | null => {
    const full = path.join(__dirname, '..', '..', file);
    if (!fs.existsSync(full)) return null;
    const text = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
    const at = text.indexOf(from);
    return at < 0 ? null : text.slice(at);
  };

  for (const p of PAIRS) {
    const server = body(p.server, p.from);
    const client = body(p.client, p.from);
    check(`both ${p.name} files were found`, [server != null, client != null], [true, true]);
    check(`the ${p.name} client mirror is identical to the server engine`, server === client, true);
    if (server && client && server !== client) {
      const a = server.split('\n');
      const b = client.split('\n');
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
          console.log(`        first difference at line ${i + 1} of the shared body:`);
          console.log(`          server: ${a[i] ?? '(missing)'}`);
          console.log(`          client: ${b[i] ?? '(missing)'}`);
          break;
        }
      }
    }
  }
}

console.log('\n--- permissions: the catalogue and the routes agree ---');
{
  /**
   * The catalogue is code and the roles that use it are data, which leaves exactly two ways
   * for a permission to become a lie. Both are checked here because neither shows up as a
   * type error or a failing request — they show up as an Admin ticking a box that does
   * nothing, or as a route nobody can reach.
   *
   * 1. An ORPHAN: a key in the catalogue that no route enforces. It appears in the Roles
   *    screen with a paragraph describing what it allows, is granted in good faith, and
   *    guards nothing at all.
   * 2. A GHOST: a route asking for a key the catalogue does not define. No role can ever be
   *    granted it, so the route is permanently unreachable by everyone except an owner.
   */
  const routesDir = path.join(__dirname, '..', 'src', 'routes');
  const referenced = new Set<string>();
  for (const file of fs.readdirSync(routesDir).filter((f) => f.endsWith('.ts'))) {
    const text = fs.readFileSync(path.join(routesDir, file), 'utf8');
    // Every guard states its keys as plain single-quoted literals — `can('a.b')`,
    // `canAny('a.b', 'c.d')`, `may(req, 'a.b')` — so the dotted strings in a route file are
    // the keys it uses. Anything dotted that is NOT a key is caught by the ghost check.
    for (const m of text.matchAll(/'([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+)'/g)) referenced.add(m[1]);
  }

  const catalogue = new Set(PERMISSION_KEYS);
  const orphans = [...catalogue].filter((k) => !referenced.has(k));
  const ghosts = [...referenced].filter((k) => !catalogue.has(k));

  check('every catalogue key is enforced by at least one route', orphans, []);
  if (orphans.length) console.log(`        orphaned (grant them and nothing happens): ${orphans.join(', ')}`);
  check('no route asks for a key the catalogue does not define', ghosts, []);
  if (ghosts.length) console.log(`        ghosts (no role can ever hold them): ${ghosts.join(', ')}`);

  // Keys are the API of the whole thing, so their shape is fixed rather than conventional.
  const badShape = PERMISSIONS.filter((p) => !/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(p.key)).map((p) => p.key);
  check('every key is lower-case dotted segments', badShape, []);
  check('no key is defined twice', PERMISSION_KEYS.length, catalogue.size);

  // The prose is not decoration — it is what somebody granting the permission reads, and an
  // empty `blocks` list is the specific omission that makes a grant feel safer than it is.
  const noWhat = PERMISSIONS.filter((p) => p.what.trim().length < 40).map((p) => p.key);
  const noAllows = PERMISSIONS.filter((p) => p.allows.length === 0).map((p) => p.key);
  const noBlocks = PERMISSIONS.filter((p) => p.blocks.length === 0).map((p) => p.key);
  check('every permission explains what it does', noWhat, []);
  check('every permission lists what it allows', noAllows, []);
  check('every permission lists what it does NOT allow', noBlocks, []);

  // A module heading that is not in the list would render in no group and be invisible.
  const modules = new Set<string>(PERMISSION_MODULES);
  check('every permission sits in a declared module', PERMISSIONS.filter((p) => !modules.has(p.module as never)).map((p) => p.key), []);
  check('grouping loses nothing', permissionsByModule().reduce((n, g) => n + g.permissions.length, 0), PERMISSIONS.length);

  // `requires` is walked recursively when a role is saved, so a cycle would hang the save
  // and a dangling name would silently grant nothing.
  const dangling = PERMISSIONS.flatMap((p) => (p.requires ?? []).filter((r) => !catalogue.has(r)).map((r) => `${p.key} -> ${r}`));
  check('no requires points at a key that does not exist', dangling, []);
  const selfRef = PERMISSIONS.filter((p) => (p.requires ?? []).includes(p.key)).map((p) => p.key);
  check('nothing requires itself', selfRef, []);

  const cyclic: string[] = [];
  for (const p of PERMISSIONS) {
    const seen = new Set<string>();
    const stack = [p.key];
    let hit = false;
    while (stack.length) {
      const k = stack.pop()!;
      if (seen.has(k)) continue;
      seen.add(k);
      for (const r of permissionDef(k)?.requires ?? []) {
        if (r === p.key) hit = true;
        stack.push(r);
      }
    }
    if (hit) cyclic.push(p.key);
  }
  check('the requires graph is acyclic', cyclic, []);

  // Closing a set over `requires` is what the save does. It must be idempotent, or saving a
  // role twice would keep growing it.
  const oneEdit = withRequired(['orders.edit']);
  check('closing over requires pulls in the view permission', oneEdit.includes('orders.view'), true);
  check('closing over requires is idempotent', withRequired(oneEdit).sort(), oneEdit.sort());
  check('an unknown key is dropped rather than stored', withRequired(['orders.view', 'not.a.real.key']), ['orders.view']);
  // The deepest chain in the catalogue is three long (purge -> restore -> view), so the walk
  // has to be recursive rather than one level deep.
  check('requires is followed transitively', withRequired(['orders.purge']).sort(), ['orders.purge', 'orders.restore', 'orders.view']);

  // The one leak this whole exercise was built to close: the finance reads used to sit behind
  // `authenticate` alone, so any login could pull every buyer balance and party statement.
  const financeText = fs.readFileSync(path.join(routesDir, 'ops.production.routes.ts'), 'utf8');
  for (const route of ['/finance/receivables', '/finance/payables', '/finance/summary', '/finance/parties', '/finance/statement']) {
    const at = financeText.indexOf(`'${route}',`);
    const guard = at < 0 ? '' : financeText.slice(at, at + 200);
    check(`${route} is behind a money permission`, at >= 0 && /can\('money\./.test(guard), true);
  }
}

console.log('\n--- steps paid together as one job ---');
{
  /**
   * A labourer engaged for a run of steps at ONE agreed price — "joining, sanding and
   * polishing, ₹500 a piece" — rather than a rate per step. The run shares a `pieceGroup`, the
   * price sits on its LAST member, and the earlier ones hold zero.
   *
   * Storing it that way is what keeps the money engines free of special cases: earning still
   * happens on the clearance leaving the stage that carries the rate, exactly as it always did.
   * What the group buys is ATTRIBUTION across the run, which is otherwise refused.
   */
  const bundled: StageRow[] = [
    { id: 1, name: 'joining', sortOrder: 0, vendorId: null, jobworkRate: 0, labourRate: 0, pieceGroup: 'Job A' },
    { id: 2, name: 'sanding', sortOrder: 1, vendorId: null, jobworkRate: 0, labourRate: 0, pieceGroup: 'Job A' },
    { id: 3, name: 'polishing', sortOrder: 2, vendorId: null, jobworkRate: 0, labourRate: 500, pieceGroup: 'Job A' },
    { id: 4, name: 'qc', sortOrder: 3, vendorId: null, jobworkRate: 0, labourRate: 40 },
  ];
  const line = { id: 1, qty: 10, stages: bundled, product: { factoryCode: 'X', name: 'X' } };

  // Worked as such a job is: the run cleared in ONE action, the worker named once on the hop
  // that leaves the stage holding the price.
  const oneGo: MoveRow[] = [
    { id: 1, kind: 'RELEASE', fromStageId: null, toStageId: 1, qty: 10 },
    { id: 2, kind: 'ADVANCE', fromStageId: 1, toStageId: 2, qty: 10 },
    { id: 3, kind: 'ADVANCE', fromStageId: 2, toStageId: 3, qty: 10 },
    { id: 4, kind: 'ADVANCE', fromStageId: 3, toStageId: 4, qty: 10, workers: [{ workerId: 7, pieces: 10 }] },
  ];
  const b = buildBoard(10, bundled, oneGo);
  const earned = labourEvents({ id: 1, number: 'ORD-1' }, { ...line, moves: oneGo } as never);
  check('the run is paid once, at the agreed price', earned.reduce((a, e) => a + e.amount, 0), 10 * 500);
  check('and the board says the same', b.stages.reduce((a, s) => a + s.labourValue, 0), 10 * 500);
  check('the worker is credited the pieces ONCE, not once per step', earned.reduce((a, e) => a + e.pieces, 0), 10);
  check('the unpaid members of the run are never flagged', [b.stages[0].unattributed, b.stages[1].unattributed], [0, 0]);
  check('nor is the step that carries the price, once it is named', b.stages[2].unattributed, 0);

  // The same run cleared without naming anybody is still reported, once, on the priced step.
  const nobody = oneGo.map((m) => (m.id === 4 ? { ...m, workers: undefined } : m));
  const nb = buildBoard(10, bundled, nobody);
  check('cleared with nobody named, the run reports once', nb.stages.map((s) => s.unattributed), [0, 0, 10, 0]);

  /**
   * The attribution rule itself, which the client mirrors in `moveLogic.ts`. Only a run whose
   * every crossed step belongs to the same group may be attributed in one action — the reason
   * a multi-stage clearance is normally refused is that each step has its own price, and with
   * one price for the run there is nothing left to split.
   */
  check('a run of one group may be attributed', spansOnePieceGroup(bundled[0], bundled[2]), true);
  check('crossing out of the group may not', spansOnePieceGroup(bundled[0], bundled[3]), false);
  check('nor may two ungrouped steps', spansOnePieceGroup(bundled[3], bundled[3]), false);
  check('a step in no group is never bundled with itself', spansOnePieceGroup({ pieceGroup: null }, { pieceGroup: null }), false);
}

console.log('\n--- in-house piece work nobody was named for ---');
{
  /**
   * A stage may carry a piece rate and still be cleared without anybody being named — either
   * because the supervisor forgot, or because the pieces were moved across several stages in
   * one action, which cannot be attributed at all.
   *
   * The board used to price that as `cleared × labourRate`, so it announced wages that no
   * worker account held a paisa of: 40 pieces at ₹60 read as ₹2,400 earned and paid out ₹0.
   * It is now priced off the pieces actually attributed, and the shortfall is reported as
   * `unattributed` so somebody can act on it.
   */
  const stages: StageRow[] = [
    { id: 1, name: 'joining', sortOrder: 0, vendorId: null, jobworkRate: 0, labourRate: 60 },
    { id: 2, name: 'sanding', sortOrder: 1, vendorId: null, jobworkRate: 0, labourRate: 30 },
    { id: 3, name: 'polishing', sortOrder: 2, vendorId: null, jobworkRate: 0, labourRate: 45 },
    { id: 4, name: 'qc', sortOrder: 3, vendorId: null, jobworkRate: 0, labourRate: 0 },
  ];
  const line = { id: 1, qty: 40, stages, product: { factoryCode: 'X', name: 'X' } };
  const agree = (name: string, moves: MoveRow[], wantValue: number, wantUnattributed: number) => {
    const b = buildBoard(40, stages, moves);
    const boardSays = b.stages.reduce((a, s) => a + s.labourValue, 0);
    const wages = labourEvents({ id: 1, number: 'ORD-1' }, { ...line, moves } as never).reduce((a, e) => a + e.amount, 0);
    check(`${name}: the board and the wage ledger agree`, boardSays, wages);
    check(`${name}: and the figure is right`, boardSays, wantValue);
    check(`${name}: unattributed pieces reported`, b.stages.reduce((a, s) => a + s.unattributed, 0), wantUnattributed);
  };

  const release: MoveRow = { id: 1, kind: 'RELEASE', fromStageId: null, toStageId: 1, qty: 40 };

  agree(
    'named every time',
    [release,
      { id: 2, kind: 'ADVANCE', fromStageId: 1, toStageId: 2, qty: 40, workers: [{ workerId: 7, pieces: 40 }] },
      { id: 3, kind: 'ADVANCE', fromStageId: 2, toStageId: 3, qty: 40, workers: [{ workerId: 7, pieces: 40 }] }],
    40 * 60 + 40 * 30,
    0
  );

  // Rates set on every stage, nobody named — day-wage work, so it costs nothing per piece.
  agree('nobody named', [release,
    { id: 2, kind: 'ADVANCE', fromStageId: 1, toStageId: 2, qty: 40 },
    { id: 3, kind: 'ADVANCE', fromStageId: 2, toStageId: 3, qty: 40 }], 0, 80);

  // Moved straight through: three stages cleared by one action, none attributable.
  agree('moved across several stages at once', [release,
    { id: 2, kind: 'ADVANCE', fromStageId: 1, toStageId: 2, qty: 40 },
    { id: 3, kind: 'ADVANCE', fromStageId: 2, toStageId: 3, qty: 40 },
    { id: 4, kind: 'ADVANCE', fromStageId: 3, toStageId: 4, qty: 40 }], 0, 120);

  // Half attributed: the named half earns, the rest is reported.
  agree('partly attributed', [release,
    { id: 2, kind: 'ADVANCE', fromStageId: 1, toStageId: 2, qty: 25, workers: [{ workerId: 7, pieces: 25 }] },
    { id: 3, kind: 'ADVANCE', fromStageId: 1, toStageId: 2, qty: 15 }], 25 * 60, 15);

  // A stage with NO piece rate is day-wage by definition, so it is never reported.
  const noRate: StageRow[] = [{ id: 1, name: 'joining', sortOrder: 0, vendorId: null, jobworkRate: 0, labourRate: 0 }, ...stages.slice(1)];
  const b = buildBoard(40, noRate, [release, { id: 2, kind: 'ADVANCE', fromStageId: 1, toStageId: 2, qty: 40 }]);
  check('a stage with no piece rate is never flagged', b.stages[0].unattributed, 0);

  // Nor is a vendor stage: the vendor is owed whoever held the tools.
  const vendorStages: StageRow[] = [{ id: 1, name: 'coating', sortOrder: 0, vendorId: 9, jobworkRate: 45, labourRate: 0 }, ...stages.slice(1)];
  const vb = buildBoard(40, vendorStages, [release, { id: 2, kind: 'ADVANCE', fromStageId: 1, toStageId: 2, qty: 40 }]);
  check('a vendor stage is never flagged', vb.stages[0].unattributed, 0);
  check('and is still owed without anybody being named', vb.stages[0].jobworkValue, 40 * 45);
}

console.log('\n--- rework nobody pays for ---');
{
  /**
   * A vendor whose coating blistered used to be paid twice for the same pieces: the board
   * counts movements, and putting it right is a genuine second movement. `billable: false`
   * records the clearance without the earning — the pieces still move, only the money stops.
   */
  const stages: StageRow[] = [
    { id: 1, name: 'coating', sortOrder: 0, vendorId: 9, jobworkRate: 45, labourRate: 0 },
    { id: 2, name: 'qc', sortOrder: 1, vendorId: null, jobworkRate: 0, labourRate: 0 },
  ];
  const paidTwice: MoveRow[] = [
    { id: 1, kind: 'RELEASE', fromStageId: null, toStageId: 1, qty: 40, date: '2026-01-01' },
    { id: 2, kind: 'ADVANCE', fromStageId: 1, toStageId: 2, qty: 40, date: '2026-01-02' },
    { id: 3, kind: 'REJECT', fromStageId: 2, toStageId: 1, qty: 6, date: '2026-01-03' },
    { id: 4, kind: 'ADVANCE', fromStageId: 1, toStageId: 2, qty: 6, date: '2026-01-04' },
  ];
  // jobworkEvents labels each earning with the product it was for.
  const line = { id: 1, qty: 40, stages, moves: paidTwice, product: { factoryCode: 'AB-2101', name: 'Aurora' } };
  const before = jobworkEvents({ id: 1, number: 'ORD-1' }, line as never);
  check('rework earns again when the factory caused it', before.reduce((a, e) => a + e.amount, 0), 40 * 45 + 6 * 45);

  // The same movements, with the re-clearance recorded as the vendor's own cost.
  const atTheirCost = paidTwice.map((m) => (m.id === 4 ? { ...m, billable: false } : m));
  const after = jobworkEvents({ id: 1, number: 'ORD-1' }, { ...line, moves: atTheirCost } as never);
  check('and earns nothing when the vendor did', after.reduce((a, e) => a + e.amount, 0), 40 * 45);

  // The board must not notice. The pieces genuinely went through.
  const boardPaid = buildBoard(40, stages, paidTwice);
  const boardFree = buildBoard(40, stages, atTheirCost);
  check('the board is identical either way', [boardFree.stages[0].at, boardFree.stages[1].at, boardFree.done], [boardPaid.stages[0].at, boardPaid.stages[1].at, boardPaid.done]);
  check('and the stage still counts the pieces as cleared', boardFree.stages[0].cleared, boardPaid.stages[0].cleared);

  // An unmarked movement is ordinary work — every row written before the flag existed.
  const legacy = jobworkEvents({ id: 1, number: 'ORD-1' }, { ...line, moves: paidTwice.map(({ ...m }) => m) } as never);
  check('a movement with no flag still earns', legacy.reduce((a, e) => a + e.amount, 0), 40 * 45 + 6 * 45);

  /**
   * THE INVARIANT. The strip drawn on the board and the ledger behind the payables page are
   * two different walks over the same movements, and they have to agree to the rupee — the
   * failure this whole file exists to prevent. Pricing the strip off `cleared` while
   * `jobworkEvents` skipped unpaid rework would have shown the vendor owed for pieces they
   * were re-doing free, which is how the two came apart the first time.
   */
  const strip = buildBoard(40, stages, atTheirCost);
  const ledger = after.reduce((a, e) => a + e.amount, 0);
  check('the board strip and the payables ledger agree', strip.stages[0].jobworkValue, ledger);
  check('and the pieces beside the amount are the billed ones', strip.stages[0].clearedBillable, 40);
  check('while the stage still reports all the work that went through it', strip.stages[0].cleared, 46);
  check('the roll-up counts billed pieces too', strip.jobwork[0]?.pieces, 40);
  check('and its amount matches', strip.jobwork[0]?.amount, 40 * 45);

  /**
   * The same discipline for in-house piece work — but it has to NAME somebody, because that is
   * what in-house work is priced off now. A worker redoing their own spoiled pieces is named on
   * the movement exactly as they were the first time; only `billable: false` stops them earning
   * for it a second time.
   */
  const inHouse: StageRow[] = [{ id: 1, name: 'polishing', sortOrder: 0, vendorId: null, jobworkRate: 0, labourRate: 30 }, ...stages.slice(1)];
  const crewed = atTheirCost.map((m) =>
    m.kind === 'ADVANCE' && m.fromStageId === 1 ? { ...m, workers: [{ workerId: 7, pieces: m.qty }] } : m
  );
  const wageStrip = buildBoard(40, inHouse, crewed);
  check('a worker redoing their own spoilage is not paid twice', wageStrip.stages[0].labourValue, 40 * 30);
  check('and the wage ledger says the same', labourEvents({ id: 1, number: 'ORD-1' }, { ...line, stages: inHouse, moves: crewed } as never).reduce((a, e) => a + e.amount, 0), 40 * 30);
  // Named and unpaid is not the same as unnamed: there is nothing left over to chase.
  check('nothing is reported as unattributed', wageStrip.stages[0].unattributed, 0);
}

console.log('\n--- what has been billed, under either basis ---');
{
  /**
   * `billed` is how much of an order's value has actually gone onto an ISSUED invoice, and it
   * is reported under BOTH bases. It was permanently zero under ORDER — the default — because
   * the two loaders skipped fetching invoices there, on the reasoning that invoices "change no
   * figure" under ORDER. True of allocation, false of this.
   *
   * The pair of checks matters more than either alone: `billed` must move, and the RECEIVABLE
   * must not, or the fix would have quietly changed what every buyer owes.
   */
  const order = {
    id: 1,
    number: 'ORD-1',
    buyerId: 9,
    status: 'Confirmed',
    orderDate: new Date('2026-01-01'),
    exchangeRate: 1,
    currency: { code: 'INR', symbol: '₹' },
    buyer: { market: 'DOMESTIC', state: 'Rajasthan' },
    taxMarket: 'DOMESTIC',
    taxBuyerState: 'Rajasthan',
    taxCompanyState: 'Rajasthan',
    charges: [],
    lines: [{ id: 1, qty: 10, unitPrice: 100, discountPct: 0, discountAmt: 0, gstRatePct: 0, stages: [], moves: [] }],
  };
  const invoice = {
    id: 5,
    number: 'INV-1',
    buyerId: 9,
    status: 'ISSUED',
    invoiceDate: new Date('2026-02-01'),
    exchangeRate: 1,
    currency: { code: 'INR', symbol: '₹' },
    buyer: { market: 'DOMESTIC', state: 'Rajasthan' },
    taxMarket: 'DOMESTIC',
    taxBuyerState: 'Rajasthan',
    taxCompanyState: 'Rajasthan',
    charges: [],
    lines: [{ id: 1, orderId: 1, qty: 6, unitPrice: 100, discountPct: 0, discountAmt: 0, gstRatePct: 0 }],
  };

  const withInv = buildFinanceContext([order] as never, [], new Map(), 'Rajasthan', { basis: 'ORDER', invoices: [invoice] as never });
  check('billed reflects the issued invoice under ORDER', withInv.invoicedValue.get(1), 600);
  const noInv = buildFinanceContext([order] as never, [], new Map(), 'Rajasthan', { basis: 'ORDER', invoices: [] as never });
  check('and is zero only when nothing has been invoiced', noInv.invoicedValue.get(1) ?? 0, 0);

  // A DRAFT is not a bill, so it must not count under either basis.
  const draft = { ...invoice, status: 'DRAFT' };
  const withDraft = buildFinanceContext([order] as never, [], new Map(), 'Rajasthan', { basis: 'ORDER', invoices: [draft] as never });
  check('a draft invoice is not billed', withDraft.invoicedValue.get(1) ?? 0, 0);

  // The order book stays empty under ORDER, or a page could show the same money twice.
  check('the order book stays empty under ORDER', withInv.orderBook.size, 0);

  /**
   * The load must not touch allocation. A buyer with an invoice but NO live order used to be
   * absent from the buyer set under ORDER; if loading invoices added them, their receipts
   * would allocate against no buckets and be reported as credit on account out of nowhere.
   */
  const strayInvoice = { ...invoice, id: 6, buyerId: 77, lines: [{ id: 2, orderId: null, qty: 1, unitPrice: 50, discountPct: 0, discountAmt: 0, gstRatePct: 0 }] };
  const receipt = { id: 1, partyType: 'BUYER', kind: 'PAYMENT', buyerId: 77, orderId: null, invoiceId: null, amount: 50, currency: 'INR', date: new Date('2026-03-01') };
  const stray = buildFinanceContext([order] as never, [receipt] as never, new Map(), 'Rajasthan', { basis: 'ORDER', invoices: [invoice, strayInvoice] as never });
  check('an invoice-only buyer invents no credit under ORDER', stray.buyerCredit.size, 0);
}

console.log('\n--- withholding money from a shared response ---');
{
  /**
   * `serializeOrder` returns the priced total, the tax breakdown, the buyer's position and the
   * jobwork accrued in the SAME object as the delivery date and the piece counts — so
   * `orders.view` was handing all of it to a floor login, which the catalogue explicitly
   * promises it does not. These check the blanking, because the failure mode is silent: the
   * page still renders, it just shows money to somebody who may not see it.
   *
   * The nested cases are the ones that actually regressed in review. A line's `unitPrice` is
   * the number the whole order value is built from, and a stage's `jobworkRate` is what a
   * vendor is paid — blanking only the top-level `total` would have left both in place.
   */
  /**
   * THE REAL RESPONSE SHAPE, not a plausible one.
   *
   * The first version of this fixture was invented from the field names that seemed likely,
   * and it passed while the live board went on printing `₹55/pc` and `$11,700.00` — because
   * the rates the UI renders live under `line.board.stages` (a derived copy) and the line
   * value is `amount`, neither of which the fixture had. A fixture that omits a field cannot
   * fail on it, so every money-bearing key below was copied off an actual `GET /orders/:id`.
   */
  const order = {
    id: 7,
    number: 'ORD-001',
    deliveryDate: '2026-09-01',
    summary: { ordered: 100, done: 40 },
    total: 12_500,
    totals: { subtotal: 12_000, grandTotal: 12_500 },
    money: { receivable: 9_000, jobworkDue: 400 },
    jobwork: [{ vendorId: 1, vendorName: 'Ace Polishing', pieces: 40, amount: 400 }],
    lines: [
      {
        id: 11,
        qty: 100,
        productCode: 'AB-00123',
        unitPrice: 125,
        discountPct: 5,
        discountAmt: 50,
        amount: 11_700,
        grossAmount: 12_500,
        lineTotal: 11_700,
        net: 11_700,
        stages: [{ id: 21, name: 'polishing', jobworkRate: 12, labourRate: 3 }],
        board: {
          done: 40,
          stages: [{ id: 21, name: 'polishing', at: 10, cleared: 60, reached: 60, jobworkRate: 12, labourRate: 3, jobworkValue: 720, labourValue: 180 }],
        },
        history: [{ id: 98, kind: 'REJECT', qty: 4, note: 'chipped', labourValue: 55 }],
      },
    ],
  };

  const blank = stripOrderMoney(order);
  check('the quantities and dates survive', [blank.number, blank.deliveryDate, blank.summary.ordered, blank.lines[0].qty], ['ORD-001', '2026-09-01', 100, 100]);
  check('the order value is blanked, not zeroed', [blank.total, blank.totals, blank.money], [null, null, null]);
  check('a line price is blanked', [blank.lines[0].unitPrice, blank.lines[0].discountPct, blank.lines[0].discountAmt], [null, null, null]);
  // The one the first attempt missed: `amount` is what the UI prints, not `unitPrice × qty`.
  check('and so is what the line is WORTH', [blank.lines[0].amount, blank.lines[0].grossAmount, blank.lines[0].lineTotal, blank.lines[0].net], [null, null, null, null]);
  check('the stored stage rate is blanked', [blank.lines[0].stages[0].jobworkRate, blank.lines[0].stages[0].labourRate], [null, null]);
  // The other one it missed: the board strip reads its own derived copy of the rates.
  check('the BOARD copy of the rate is blanked too', [blank.lines[0].board.stages[0].jobworkRate, blank.lines[0].board.stages[0].labourRate], [null, null]);
  check('as are the multiplied-out values', [blank.lines[0].board.stages[0].jobworkValue, blank.lines[0].board.stages[0].labourValue], [null, null]);
  check('and what a past movement earned', blank.lines[0].history[0].labourValue, null);
  check('but the board itself is untouched', [blank.lines[0].board.stages[0].at, blank.lines[0].board.stages[0].cleared, blank.lines[0].board.done], [10, 60, 40]);
  check('and so is the movement it earned on', [blank.lines[0].history[0].qty, blank.lines[0].history[0].note], [4, 'chipped']);
  check('the jobwork list is emptied', blank.jobwork, []);
  check('and the withholding is declared', [blank.moneyHidden, blank.ratesHidden], [true, true]);
  // Zero would be read as "nothing outstanding", which is a claim rather than an absence.
  check('nothing money-shaped came back as 0', [blank.total, blank.lines[0].unitPrice, blank.lines[0].amount, blank.lines[0].board.stages[0].labourValue].some((v) => v === 0), false);
  check('the original object is untouched', [order.total, order.lines[0].amount, order.lines[0].board.stages[0].labourValue], [12_500, 11_700, 180]);

  // Seeing what the buyer owes and seeing what the factory pays out are separate permissions,
  // so there is a case for blanking the rates while keeping the value.
  const ratesOnly = stripOrderRates(order);
  check('rates-only keeps the order value', [ratesOnly.total, ratesOnly.money.receivable, ratesOnly.lines[0].amount], [12_500, 9_000, 11_700]);
  check('rates-only clears every copy of the rates', [ratesOnly.lines[0].stages[0].jobworkRate, ratesOnly.lines[0].board.stages[0].labourRate, ratesOnly.lines[0].board.stages[0].labourValue, ratesOnly.jobwork], [null, null, null, []]);
  check('rates-only keeps the line price', ratesOnly.lines[0].unitPrice, 125);
  check('and says which half was withheld', [ratesOnly.ratesHidden, ratesOnly.moneyHidden], [true, undefined]);
  check('a line with no board or history does not throw', stripOrderMoney({ lines: [{ id: 1, qty: 5 }] }).lines[0].qty, 5);

  // A co-loaded invoice is returned WHOLE by the fulfilment read, so its total is a tax
  // document's value and not this order's share — which is why it has to go.
  const ful = {
    orderId: 7,
    totals: { shipped: 40, invoiced: 40 },
    invoices: [{ number: 'INV-001', status: 'ISSUED', exchangeRate: 83, totals: { grandTotal: 12_500 }, charges: [{ name: 'Freight', amount: 200 }], mine: { pieces: 40 }, lines: [{ orderId: 7, qty: 40, unitPrice: 125 }] }],
  };
  const fb = stripFulfilmentMoney(ful);
  check('which invoice billed the order survives', [fb.invoices[0].number, fb.invoices[0].status], ['INV-001', 'ISSUED']);
  check('how many pieces were billed survives', [fb.invoices[0].mine.pieces, fb.totals.invoiced], [40, 40]);
  check('the invoice value does not', [fb.invoices[0].totals, fb.invoices[0].exchangeRate, fb.invoices[0].charges], [null, null, []]);
  check('nor its line prices', fb.invoices[0].lines[0].unitPrice, null);
}

console.log(failed === 0 ? '\nALL SELF-CHECKS PASSED' : `\n${failed} SELF-CHECK(S) FAILED`);
if (failed) process.exitCode = 1;
