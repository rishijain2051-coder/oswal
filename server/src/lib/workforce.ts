/**
 * The workforce engine: what every worker has earned, and what is therefore owed.
 *
 * THERE ARE NO PAY PERIODS. Oswal Handicrafts pays people when it pays them — a worker may
 * draw an advance, or go two months without a payment. So a worker is a running
 * ACCOUNT, exactly like a jobwork vendor: earnings accrue as dated events and
 * payments are ad-hoc for any amount on any date. Nothing is ever run or closed, so
 * nothing can be late.
 *
 * TWO RULES, the same ones the rest of the system lives by:
 *
 * 1. NOTHING IS STORED THAT CAN BE DERIVED. A worker's earnings are
 *    (working days × their rate) + (overtime hours × OT rate) + (pieces cleared ×
 *    that stage's labour rate). There is no balance column, no wage-run table and no
 *    stored day count — which is why adding a festival to the holiday calendar, or
 *    correcting a rate, restates the money instead of leaving a wrong number behind.
 *
 * 2. ATTENDANCE IS EXCEPTIONS-ONLY. Every active worker is presumed present on every
 *    working day; a row exists only to say otherwise (or to pay someone who came in
 *    on a weekly off). Which days are working days is Admin-configured, not hard-coded.
 *
 * Two figures come out of this, and their difference is exactly the advance
 * outstanding:
 *
 *    balance = earned − deductions − statutory − payments − advances     (the party
 *              balance shown on the statement, in payables, on the dashboard)
 *    dueNow  = earned − deductions − statutory − payments − recovered   (cash due
 *              now, respecting each advance's monthly recovery cap)
 *
 *    dueNow − advanceOutstanding === balance
 *
 * That identity is asserted in prisma/verify.ts and is what keeps the worker page and
 * the payables page from ever disagreeing.
 */
import { round } from './costing';
import { clearances, type MoveRow, type StageRow } from './production';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** One worker earns by exactly one of these, so attendance can never double-pay. */
export const PAY_TYPES = ['DAY', 'PIECE', 'MONTHLY'] as const;
export type PayType = (typeof PAY_TYPES)[number];

export const ATTENDANCE_STATUSES = ['PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE', 'PAID_LEAVE'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const MONTHLY_DIVISORS = ['WORKING', 'FIXED_26', 'FIXED_30', 'CALENDAR'] as const;
export type MonthlyDivisor = (typeof MONTHLY_DIVISORS)[number];

export const STATUTORY_BASES = ['GROSS', 'BASIC'] as const;
export type StatutoryBasis = (typeof STATUTORY_BASES)[number];

/** The rules the Admin decides. Mirrors the WorkforceSetting singleton. */
export interface WorkforceRules {
  /** JS day numbers that are weekly offs — 0 = Sunday. */
  weeklyOffDays: number[];
  presumePresent: boolean;
  shiftHours: number;
  otMultiplier: number;
  halfDayFactor: number;
  monthlyDivisor: MonthlyDivisor;
}

export const DEFAULT_RULES: WorkforceRules = {
  weeklyOffDays: [0],
  presumePresent: true,
  shiftHours: 8,
  otMultiplier: 2,
  halfDayFactor: 0.5,
  monthlyDivisor: 'WORKING',
};

/** Parse the stored CSV ("0,6") into day numbers, ignoring anything nonsensical. */
export function parseWeeklyOffDays(csv: string | null | undefined): number[] {
  if (!csv) return [];
  return [
    ...new Set(
      String(csv)
        .split(',')
        .map((p) => Number(p.trim()))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    ),
  ].sort();
}

export function rulesFrom(setting: Partial<{ weeklyOffDays: string; presumePresent: boolean; shiftHours: number; otMultiplier: number; halfDayFactor: number; monthlyDivisor: string }> | null | undefined): WorkforceRules {
  if (!setting) return DEFAULT_RULES;
  const divisor = MONTHLY_DIVISORS.includes(setting.monthlyDivisor as MonthlyDivisor) ? (setting.monthlyDivisor as MonthlyDivisor) : DEFAULT_RULES.monthlyDivisor;
  return {
    weeklyOffDays: setting.weeklyOffDays != null ? parseWeeklyOffDays(setting.weeklyOffDays) : DEFAULT_RULES.weeklyOffDays,
    presumePresent: setting.presumePresent ?? DEFAULT_RULES.presumePresent,
    shiftHours: setting.shiftHours && setting.shiftHours > 0 ? setting.shiftHours : DEFAULT_RULES.shiftHours,
    otMultiplier: setting.otMultiplier ?? DEFAULT_RULES.otMultiplier,
    halfDayFactor: setting.halfDayFactor ?? DEFAULT_RULES.halfDayFactor,
    monthlyDivisor: divisor,
  };
}

// ---------------------------------------------------------------------------
// Dates
//
// Attendance is a calendar fact, not an instant, so everything here works in whole
// local days and compares by a "YYYY-MM-DD" key. Writing dates through dayStart()
// keeps the unique(workerId, date) index honest.
// ---------------------------------------------------------------------------

export function dayStart(d: Date | string): Date {
  const x = new Date(d);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate());
}

export function dayKey(d: Date | string): string {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

export function monthKey(d: Date | string): string {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
}

/** Every calendar day from `from` to `to` inclusive. */
export function eachDay(from: Date | string, to: Date | string): Date[] {
  const out: Date[] = [];
  const end = dayStart(to).getTime();
  for (let d = dayStart(from); d.getTime() <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) out.push(d);
  return out;
}

export function daysInMonth(key: string): number {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/** A working day is any day that is neither a weekly off nor a factory holiday. */
export function isWorkingDay(date: Date | string, rules: WorkforceRules, holidays: Set<string>): boolean {
  const d = dayStart(date);
  if (rules.weeklyOffDays.includes(d.getDay())) return false;
  return !holidays.has(dayKey(d));
}

export function workingDaysInMonth(key: string, rules: WorkforceRules, holidays: Set<string>): number {
  const [y, m] = key.split('-').map(Number);
  return eachDay(new Date(y, m - 1, 1), new Date(y, m, 0)).filter((d) => isWorkingDay(d, rules, holidays)).length;
}

/**
 * What one day of a monthly salary is worth in a given month.
 *
 * WORKING divides by that month's own working days, so a full month accrues exactly
 * the salary and an absence docks precisely one day. The FIXED_* divisors are the
 * conventional 26- and 30-day bases: they are opt-in because in a month with more
 * working days than the divisor they accrue slightly more than the salary — which is
 * what "26-day basis" means in practice.
 */
export function monthlyPerDay(monthly: number, key: string, rules: WorkforceRules, holidays: Set<string>): number {
  if (monthly <= 0) return 0;
  let divisor: number;
  switch (rules.monthlyDivisor) {
    case 'FIXED_26':
      divisor = 26;
      break;
    case 'FIXED_30':
      divisor = 30;
      break;
    case 'CALENDAR':
      divisor = daysInMonth(key);
      break;
    default:
      divisor = workingDaysInMonth(key, rules, holidays);
  }
  return divisor > 0 ? monthly / divisor : 0;
}

// ---------------------------------------------------------------------------
// Earnings
// ---------------------------------------------------------------------------

export interface WorkerForAccrual {
  id: number;
  code?: string;
  name?: string;
  payType: string;
  dailyRate: number;
  otHourlyRate: number;
  monthlySalary: number;
  joinedOn: Date | string;
  exitOn?: Date | string | null;
  /** Derive wages only from this date on; see Worker.accrualFrom. */
  accrualFrom?: Date | string | null;
  isActive?: boolean;
  contractorId?: number | null;
}

/** The first day the engine may accrue for — never before the worker was employed. */
export function accrualStart(worker: WorkerForAccrual): Date {
  const joined = dayStart(worker.joinedOn);
  if (!worker.accrualFrom) return joined;
  const from = dayStart(worker.accrualFrom);
  return from.getTime() > joined.getTime() ? from : joined;
}

export interface AttendanceRow {
  date: Date | string;
  status: string;
  otHours?: number;
  note?: string | null;
}

/** A dated thing a worker earned. The statement and every total are built from these. */
export interface EarningEvent {
  key: string;
  workerId: number;
  date: Date;
  /** MANUAL is wages recorded by hand before this module existed. */
  kind: 'DAY' | 'SALARY' | 'OT' | 'PIECE' | 'MANUAL';
  label: string;
  /** Days credited (1 or a half day). Zero for overtime and piece work. */
  days: number;
  hours: number;
  pieces: number;
  rate: number;
  amount: number;
  /**
   * Overtime is money but not "wages" for a statutory component on a BASIC basis,
   * which is how PF is normally computed.
   */
  overtime: boolean;
  orderId?: number | null;
  orderNumber?: string | null;
  stage?: string | null;
}

/** What a day of attendance is worth, as a multiple of a day's pay. */
function dayFactor(status: string | undefined, rules: WorkforceRules, working: boolean): number {
  switch (status) {
    case 'PRESENT':
    case 'PAID_LEAVE':
      return 1;
    case 'HALF_DAY':
      return rules.halfDayFactor;
    case 'ABSENT':
    case 'LEAVE':
      return 0;
    default:
      // No row at all: presumed present, but only on a day that is actually worked.
      return working && rules.presumePresent ? 1 : 0;
  }
}

/** The hourly overtime rate, derived from the day's pay when the worker has none set. */
export function overtimeRate(worker: WorkerForAccrual, dayValue: number, rules: WorkforceRules): number {
  if (worker.otHourlyRate > 0) return worker.otHourlyRate;
  if (dayValue <= 0 || rules.shiftHours <= 0) return 0;
  return (dayValue / rules.shiftHours) * rules.otMultiplier;
}

/**
 * Attendance money for one worker over a date window.
 *
 * A PIECE worker earns nothing here — their pay comes off the board — so marking them
 * present cannot pay them twice. Days outside employment never accrue, and a
 * non-working day pays only when someone explicitly marked attendance on it.
 */
export function attendanceEarnings(worker: WorkerForAccrual, attendance: AttendanceRow[], from: Date | string, to: Date | string, rules: WorkforceRules, holidays: Set<string>): EarningEvent[] {
  if (worker.payType === 'PIECE') return [];

  const byDay = new Map(attendance.map((a) => [dayKey(a.date), a]));
  const start = dayStart(new Date(Math.max(dayStart(from).getTime(), accrualStart(worker).getTime())));
  const stop = worker.exitOn ? new Date(Math.min(dayStart(to).getTime(), dayStart(worker.exitOn).getTime())) : dayStart(to);
  if (stop.getTime() < start.getTime()) return [];

  const events: EarningEvent[] = [];
  for (const day of eachDay(start, stop)) {
    const key = dayKey(day);
    const row = byDay.get(key);
    const working = isWorkingDay(day, rules, holidays);
    const dayValue = worker.payType === 'MONTHLY' ? monthlyPerDay(worker.monthlySalary, monthKey(day), rules, holidays) : worker.dailyRate;

    const factor = dayFactor(row?.status, rules, working);
    if (factor > 0 && dayValue > 0) {
      const half = factor < 1;
      events.push({
        key: `day-${worker.id}-${key}`,
        workerId: worker.id,
        date: day,
        kind: worker.payType === 'MONTHLY' ? 'SALARY' : 'DAY',
        label: half ? 'Half day' : row?.status === 'PAID_LEAVE' ? 'Paid leave' : !working ? 'Worked on a day off' : 'Present',
        days: factor,
        hours: 0,
        pieces: 0,
        rate: round(dayValue),
        amount: round(dayValue * factor),
        overtime: false,
      });
    }

    const otHours = row?.otHours ?? 0;
    if (otHours > 0) {
      const rate = overtimeRate(worker, dayValue, rules);
      if (rate > 0) {
        events.push({
          key: `ot-${worker.id}-${key}`,
          workerId: worker.id,
          date: day,
          kind: 'OT',
          label: `Overtime ${otHours} h`,
          days: 0,
          hours: otHours,
          pieces: 0,
          rate: round(rate),
          amount: round(otHours * rate),
          overtime: true,
        });
      }
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Piece work off the production board
// ---------------------------------------------------------------------------

export interface LineForLabour {
  id: number;
  product: { factoryCode: string; name: string };
  stages: (StageRow & { name: string; sortOrder: number; labourRate?: number })[];
  moves: (MoveRow & { note?: string | null; workers?: { workerId: number; pieces: number; worker?: { name: string } | null }[] })[];
}

/**
 * Piece earnings for every worker named on a clearance out of an IN-HOUSE stage.
 *
 * Priced at the stage's current labourRate, exactly as vendor jobwork is priced, so
 * the same rules hold: work re-done after a rejection earns again, and the totals
 * reconcile with the board's `cleared` figure. Nothing accrues for a stage that is
 * outsourced (the vendor is paid instead) or for a movement with nobody named on it.
 */
export function labourEvents(order: { id: number; number: string }, line: LineForLabour): EarningEvent[] {
  const events: EarningEvent[] = [];
  for (const { move, stage, rework } of clearances(line.stages, line.moves)) {
    if (stage.vendorId) continue;
    const named = move.workers ?? [];
    if (named.length === 0) continue;
    const rate = stage.labourRate ?? 0;
    for (const w of named) {
      if (w.pieces <= 0) continue;
      events.push({
        key: `piece-${move.id}-${w.workerId}`,
        workerId: w.workerId,
        date: new Date(move.date ?? new Date()),
        kind: 'PIECE',
        label: `${stage.name} — ${w.pieces} pc${rework ? ' (re-done)' : ''}`,
        days: 0,
        hours: 0,
        pieces: w.pieces,
        rate: round(rate),
        amount: round(w.pieces * rate),
        overtime: false,
        orderId: order.id,
        orderNumber: order.number,
        stage: stage.name,
      });
    }
  }
  return events;
}

/**
 * Piece counts must add up to the pieces that moved.
 *
 * Otherwise the money would stop reconciling with the board: name two workers with
 * 3 pieces each on a movement of 10 and four pieces' worth of labour vanishes.
 */
export function validateMoveWorkers(qty: number, workers: { workerId: number; pieces: number }[], stage: { vendorId: number | null; labourRate: number; name: string }): string | null {
  if (workers.length === 0) return null;
  if (stage.vendorId) return `${stage.name} is outsourced — the vendor is paid for it, so workers cannot be named on it.`;
  const ids = new Set<number>();
  for (const w of workers) {
    if (!Number.isInteger(w.pieces) || w.pieces <= 0) return 'Each worker needs a whole number of 1 piece or more.';
    if (ids.has(w.workerId)) return 'The same worker is listed twice — combine their pieces into one line.';
    ids.add(w.workerId);
  }
  const total = workers.reduce((a, w) => a + w.pieces, 0);
  if (total !== qty) return `The pieces per worker add up to ${total}, but ${qty} pc are being moved.`;
  if (!(stage.labourRate > 0)) return `${stage.name} has no piece rate, so there is nothing to pay the workers named on it. Set a labour rate on the stage first.`;
  return null;
}

// ---------------------------------------------------------------------------
// Statutory components
// ---------------------------------------------------------------------------

export interface StatutoryComponentDef {
  id: number;
  code: string;
  name: string;
  employeePct: number;
  employerPct: number;
  flatAmount: number;
  basis: string;
  wageCeiling?: number | null;
  eligibilityCeiling?: number | null;
  minWages?: number | null;
  isProvision?: boolean;
  isActive?: boolean;
}

/**
 * The levies as they stand today, seeded as EDITABLE data exactly as
 * BUILTIN_METHODS seeds the cost formulas. Rates and ceilings change with the law, so
 * the Admin owns these rows — nothing in the code reads a hard-coded percentage.
 */
export const BUILTIN_STATUTORY = [
  { code: 'PF', name: 'Provident Fund', employeePct: 12, employerPct: 12, flatAmount: 0, basis: 'BASIC', wageCeiling: 15000, eligibilityCeiling: null, minWages: null, payeeName: 'EPFO', isProvision: false, sortOrder: 1, notes: 'Employee and employer each contribute 12% of basic wages, capped at the ₹15,000 ceiling. Overtime is excluded.' },
  { code: 'ESI', name: 'Employees State Insurance', employeePct: 0.75, employerPct: 3.25, flatAmount: 0, basis: 'GROSS', wageCeiling: null, eligibilityCeiling: 21000, minWages: null, payeeName: 'ESIC', isProvision: false, sortOrder: 2, notes: 'Applies to gross wages up to ₹21,000 a month; above that the worker is out of the scheme.' },
  { code: 'PT', name: 'Professional Tax', employeePct: 0, employerPct: 0, flatAmount: 200, basis: 'GROSS', wageCeiling: null, eligibilityCeiling: null, minWages: 15000, payeeName: 'State Government', isProvision: false, sortOrder: 3, notes: 'A flat monthly deduction once wages reach the threshold. Slabs vary by state — edit to match yours.' },
  { code: 'BONUS', name: 'Statutory Bonus', employeePct: 0, employerPct: 8.33, flatAmount: 0, basis: 'BASIC', wageCeiling: 7000, eligibilityCeiling: 21000, minWages: null, payeeName: '', isProvision: true, sortOrder: 4, notes: 'Accrued as a provision so the annual figure is never a surprise. Becomes a payable only when declared.' },
] as const;

export interface StatutoryResult {
  componentId: number;
  code: string;
  /** The base the contribution was worked out on, after any ceiling. */
  wages: number;
  employeeAmt: number;
  employerAmt: number;
  covered: boolean;
  /** Why nothing is due, when nothing is. */
  reason?: string;
}

/**
 * One component against one worker's wages for a period.
 *
 * The eligibility ceiling decides whether the worker is in at all (ESI's ₹21,000);
 * the wage ceiling caps what the percentage is applied to (PF's ₹15,000). A flat
 * amount replaces the employee percentage, which is how professional tax works.
 */
export function computeStatutory(def: StatutoryComponentDef, wages: { gross: number; basic: number }): StatutoryResult {
  const base = def.basis === 'BASIC' ? wages.basic : wages.gross;
  const nil = (reason: string): StatutoryResult => ({ componentId: def.id, code: def.code, wages: round(base), employeeAmt: 0, employerAmt: 0, covered: false, reason });

  if (base <= 0) return nil('No wages in this period.');
  if (def.eligibilityCeiling != null && base > def.eligibilityCeiling) return nil(`Wages above the ₹${def.eligibilityCeiling} eligibility ceiling.`);
  if (def.minWages != null && base < def.minWages) return nil(`Wages below the ₹${def.minWages} threshold.`);

  const contributory = def.wageCeiling != null ? Math.min(base, def.wageCeiling) : base;
  const employeeAmt = def.flatAmount > 0 ? def.flatAmount : (contributory * def.employeePct) / 100;
  const employerAmt = (contributory * def.employerPct) / 100;

  return { componentId: def.id, code: def.code, wages: round(contributory), employeeAmt: round(employeeAmt), employerAmt: round(employerAmt), covered: true };
}

/** Split a worker's earnings into the two bases a component can be computed on. */
export function wageBase(events: EarningEvent[]): { gross: number; basic: number } {
  const gross = events.reduce((a, e) => a + e.amount, 0);
  const basic = events.filter((e) => !e.overtime).reduce((a, e) => a + e.amount, 0);
  return { gross: round(gross), basic: round(basic) };
}

// ---------------------------------------------------------------------------
// Advances
// ---------------------------------------------------------------------------

export interface AdvanceRow {
  id: number;
  date: Date | string;
  amount: number;
  /** ₹ per calendar month that earnings may absorb. 0 = as fast as they allow. */
  recoveryPerMonth: number;
}

export interface RecoveryRow {
  advanceId: number;
  month: string;
  /** Dated at the end of the month whose earnings absorbed it. */
  date: Date;
  amount: number;
}

export interface AdvanceState {
  advanceId: number;
  date: Date | string;
  amount: number;
  recovered: number;
  outstanding: number;
}

/**
 * Work out how much of each advance the worker's earnings have absorbed.
 *
 * Earnings in a month pay off the oldest advance first, at most `recoveryPerMonth`
 * of it. A cap of 0 means "absorb whatever the earnings allow", which makes the
 * advance behave exactly like a payment that outran the earnings — the simplest case
 * and the default.
 *
 * Recovery is DERIVED on every read, so raising the cap, back-dating an advance or
 * correcting a rate all restate it correctly. There is nothing to go stale.
 */
export function recoverAdvances(advances: AdvanceRow[], earnings: EarningEvent[]): { recoveries: RecoveryRow[]; advances: AdvanceState[] } {
  const ordered = [...advances].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime() || a.id - b.id);
  const remaining = new Map<number, number>(ordered.map((a) => [a.id, round(a.amount)]));
  const recoveries: RecoveryRow[] = [];

  const earnedByMonth = new Map<string, number>();
  for (const e of earnings) earnedByMonth.set(monthKey(e.date), round((earnedByMonth.get(monthKey(e.date)) ?? 0) + e.amount));

  for (const month of [...earnedByMonth.keys()].sort()) {
    let available = earnedByMonth.get(month) ?? 0;
    if (available <= 0) continue;
    const [y, m] = month.split('-').map(Number);
    const monthEnd = new Date(y, m, 0);

    for (const adv of ordered) {
      if (available <= 0) break;
      const left = remaining.get(adv.id) ?? 0;
      if (left <= 0) continue;
      // An advance cannot be recovered out of earnings from before it was given.
      if (monthKey(adv.date) > month) continue;
      const cap = adv.recoveryPerMonth > 0 ? adv.recoveryPerMonth : Infinity;
      const take = round(Math.min(left, cap, available));
      if (take <= 0) continue;
      remaining.set(adv.id, round(left - take));
      available = round(available - take);
      recoveries.push({ advanceId: adv.id, month, date: monthEnd, amount: take });
    }
  }

  return {
    recoveries,
    advances: ordered.map((a) => {
      const left = remaining.get(a.id) ?? 0;
      return { advanceId: a.id, date: a.date, amount: round(a.amount), recovered: round(a.amount - left), outstanding: round(left) };
    }),
  };
}

// ---------------------------------------------------------------------------
// A worker's position
// ---------------------------------------------------------------------------

export interface ChargeRow {
  id: number;
  date: Date | string;
  amount: number;
  label: string;
}

export interface WorkerPositionInput {
  workerId: number;
  earnings: EarningEvent[];
  /** Canteen, damage, fines — charges against the worker, no cash involved. */
  deductions: ChargeRow[];
  /** Employee share of posted statutory liability. */
  statutory: ChargeRow[];
  advances: AdvanceRow[];
  /** Ordinary wage payments — cash out that is NOT an advance. */
  payments: ChargeRow[];
}

export interface WorkerPosition {
  workerId: number;
  earned: number;
  earnedDays: number;
  earnedPieces: number;
  overtimeEarned: number;
  deducted: number;
  statutoryDeducted: number;
  advanced: number;
  advanceRecovered: number;
  advanceOutstanding: number;
  paid: number;
  /** Cash due to the worker right now, honouring each advance's recovery cap. */
  dueNow: number;
  /** The party balance: positive = we owe them, negative = they owe us. */
  balance: number;
  recoveries: RecoveryRow[];
  advanceStates: AdvanceState[];
}

export function workerPosition(input: WorkerPositionInput): WorkerPosition {
  const sum = (rows: { amount: number }[]) => round(rows.reduce((a, r) => a + r.amount, 0));

  const earned = sum(input.earnings);
  const deducted = sum(input.deductions);
  const statutoryDeducted = sum(input.statutory);
  const paid = sum(input.payments);
  const advanced = round(input.advances.reduce((a, x) => a + x.amount, 0));

  const { recoveries, advances } = recoverAdvances(input.advances, input.earnings);
  const advanceRecovered = round(recoveries.reduce((a, r) => a + r.amount, 0));
  const advanceOutstanding = round(advances.reduce((a, s) => a + s.outstanding, 0));

  const dueNow = round(earned - deducted - statutoryDeducted - advanceRecovered - paid);
  const balance = round(earned - deducted - statutoryDeducted - advanced - paid);

  return {
    workerId: input.workerId,
    earned,
    earnedDays: round(input.earnings.reduce((a, e) => a + e.days, 0)),
    earnedPieces: input.earnings.reduce((a, e) => a + e.pieces, 0),
    overtimeEarned: round(input.earnings.filter((e) => e.overtime).reduce((a, e) => a + e.amount, 0)),
    deducted,
    statutoryDeducted,
    advanced,
    advanceRecovered,
    advanceOutstanding,
    paid,
    dueNow,
    balance,
    recoveries,
    advanceStates: advances,
  };
}
