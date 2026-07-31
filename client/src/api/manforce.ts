import { useQuery } from '@tanstack/react-query';
import { api } from './client';

/**
 * Manforce data layer.
 *
 * Every money figure here is DERIVED by the server on read — attendance times a rate,
 * pieces cleared times a stage rate. There is nothing to cache locally and nothing to
 * keep in step: invalidate `MANFORCE_KEYS` after any write and the numbers are right.
 */

export const PAY_TYPES = ['DAY', 'PIECE', 'MONTHLY'] as const;
export type PayType = (typeof PAY_TYPES)[number];

export const PAY_TYPE_LABEL: Record<PayType, string> = {
  DAY: 'Daily wage',
  PIECE: 'Piece rate',
  MONTHLY: 'Monthly salary',
};

export const PAY_TYPE_HINT: Record<PayType, string> = {
  DAY: 'Earns a day’s pay for every working day they are not marked absent.',
  PIECE: 'Earns per piece cleared on the production board. Attendance does not pay them.',
  MONTHLY: 'Salary accrues pro-rata across the month’s working days.',
};

export const PAY_TYPE_COLOR: Record<PayType, string> = { DAY: 'blue', PIECE: 'purple', MONTHLY: 'green' };

export const ATTENDANCE_STATUSES = ['PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE', 'PAID_LEAVE'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const ATTENDANCE_LABEL: Record<AttendanceStatus, string> = {
  PRESENT: 'Present',
  ABSENT: 'Absent',
  HALF_DAY: 'Half day',
  LEAVE: 'Leave (unpaid)',
  PAID_LEAVE: 'Paid leave',
};

export const ATTENDANCE_COLOR: Record<AttendanceStatus, string> = {
  PRESENT: 'green',
  ABSENT: 'red',
  HALF_DAY: 'orange',
  LEAVE: 'default',
  PAID_LEAVE: 'cyan',
};

export const MONTHLY_DIVISORS = ['WORKING', 'FIXED_26', 'FIXED_30', 'CALENDAR'] as const;
export const MONTHLY_DIVISOR_LABEL: Record<string, string> = {
  WORKING: 'Working days in the month',
  FIXED_26: 'Fixed 26 days',
  FIXED_30: 'Fixed 30 days',
  CALENDAR: 'Calendar days in the month',
};

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Trade {
  id: number;
  name: string;
  isActive: boolean;
  sortOrder: number;
  workers: number;
}

export interface Contractor {
  id: number;
  code: string;
  name: string;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  gstNo?: string | null;
  panNo?: string | null;
  address?: string | null;
  paymentTerms?: string | null;
  isActive: boolean;
  notes?: string | null;
  workers: number;
}

export interface WorkerMoney {
  earned: number;
  paid: number;
  advanced: number;
  dueNow: number;
  balance: number;
  advanceOutstanding: number;
  days: number;
  pieces: number;
}

export interface Worker {
  id: number;
  code: string;
  name: string;
  tradeId?: number | null;
  trade?: { id: number; name: string } | null;
  contractorId?: number | null;
  contractor?: { id: number; name: string; code: string } | null;
  payType: PayType;
  dailyRate: number;
  otHourlyRate: number;
  monthlySalary: number;
  joinedOn: string;
  exitOn?: string | null;
  exitReason?: string | null;
  accrualFrom?: string | null;
  isActive: boolean;
  phone?: string | null;
  altPhone?: string | null;
  address?: string | null;
  guardianName?: string | null;
  emergencyName?: string | null;
  emergencyPhone?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
  /** Null for anyone below Manager — the server withholds it. */
  aadhaarNo?: string | null;
  panNo?: string | null;
  uanNo?: string | null;
  esicNo?: string | null;
  bankName?: string | null;
  bankAccountNo?: string | null;
  bankIfsc?: string | null;
  upiId?: string | null;
  notes?: string | null;
  photoUrl?: string | null;
  money?: WorkerMoney | null;
}

export interface EarningEvent {
  key: string;
  workerId: number;
  date: string;
  kind: 'DAY' | 'SALARY' | 'OT' | 'PIECE' | 'MANUAL';
  label: string;
  days: number;
  hours: number;
  pieces: number;
  rate: number;
  amount: number;
  overtime: boolean;
  orderId?: number | null;
  orderNumber?: string | null;
  stage?: string | null;
}

export interface AdvanceState {
  id: number;
  date: string;
  amount: number;
  recoveryPerMonth: number;
  note?: string | null;
  ref?: string | null;
  recovered: number;
  outstanding: number;
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
  /** Cash due now, honouring each advance's monthly recovery cap. */
  dueNow: number;
  /** The party balance. Negative means the worker is carrying an advance. */
  balance: number;
  recoveries: { advanceId: number; month: string; date: string; amount: number }[];
  advanceStates: { advanceId: number; date: string; amount: number; recovered: number; outstanding: number }[];
}

export interface StatementRow {
  key: string;
  date: string;
  type: 'ACCRUAL' | 'BILL' | 'INVOICE' | 'PAYMENT' | 'RECEIPT';
  description: string;
  ref?: string | null;
  charge: number;
  settle: number;
  balance: number;
  detail?: string | null;
}

export interface WorkerDetail extends Worker {
  documents: { id: number; kind: string; label?: string | null; url: string; originalName?: string | null; sortOrder: number }[];
  statutory: { id: number; componentId: number; covered: boolean; component: { id: number; code: string; name: string } }[];
  position: WorkerPosition;
  earnings: EarningEvent[];
  deductions: { id: number; date: string; amount: number; label: string }[];
  advances: AdvanceState[];
  payments: { id: number; date: string; amount: number; label: string; ref?: string | null }[];
  statutoryPosted: { id: number; date: string; amount: number; label: string }[];
  statement: StatementRow[];
}

export interface MusterWorker {
  workerId: number;
  code: string;
  name: string;
  trade?: string | null;
  contractorId?: number | null;
  contractor?: string | null;
  payType: PayType;
  paysByAttendance: boolean;
  status: AttendanceStatus | null;
  otHours: number;
  note?: string | null;
  attendanceId: number | null;
  /** What the worker counts as while nothing is recorded. */
  presumed: 'PRESENT' | 'ABSENT' | null;
}

export interface Muster {
  date: string;
  isWorkingDay: boolean;
  holiday: string | null;
  weeklyOff: boolean;
  presumePresent: boolean;
  workers: MusterWorker[];
}

export interface WorkerMonth {
  month: string;
  worker: { id: number; code: string; name: string; payType: PayType; dailyRate: number; monthlySalary: number };
  days: { date: string; isWorkingDay: boolean; holiday: string | null; status: AttendanceStatus | null; otHours: number; note?: string | null; amount: number; days: number }[];
  earned: number;
  daysPaid: number;
  otHours: number;
}

export interface WorkforceSettings {
  id: number;
  weeklyOffDays: string;
  weeklyOffDayList: number[];
  presumePresent: boolean;
  shiftHours: number;
  otMultiplier: number;
  halfDayFactor: number;
  monthlyDivisor: string;
  defaultAdvanceRecovery: number;
  holidays: { id: number; date: string; name: string }[];
}

export interface StatutoryComponent {
  id: number;
  code: string;
  name: string;
  employeePct: number;
  employerPct: number;
  flatAmount: number;
  basis: 'GROSS' | 'BASIC' | string;
  wageCeiling?: number | null;
  eligibilityCeiling?: number | null;
  minWages?: number | null;
  payeeName: string;
  isProvision: boolean;
  isActive: boolean;
  sortOrder: number;
  notes?: string | null;
  covered: number;
  postedLines: number;
}

export interface StatutoryPreview {
  from: string;
  to: string;
  components: { id: number; code: string; name: string; isProvision: boolean }[];
  lines: {
    workerId: number;
    code: string;
    name: string;
    contractorName: string | null;
    componentId: number;
    componentCode: string;
    wages: number;
    employeeAmt: number;
    employerAmt: number;
    covered: boolean;
    reason?: string;
    alreadyPosted: boolean;
  }[];
  totals: { componentId: number; code: string; workers: number; employee: number; employer: number }[];
}

export interface StatutoryPosting {
  id: number;
  number: string;
  periodFrom: string;
  periodTo: string;
  postedOn: string;
  note?: string | null;
  workers: number;
  components: string[];
  employee: number;
  employer: number;
  total: number;
}

export interface ManforceSummary {
  headcount: number;
  onRoll: number;
  contractors: number;
  gangWorkers: number;
  today: {
    date: string;
    isWorkingDay: boolean;
    holiday: string | null;
    presumePresent: boolean;
    marked: number;
    /** Full days today: those marked present plus everyone presumed so. */
    present: number;
    absent: number;
    halfDay: number;
    overtimeHours: number;
    presumedPresent: number;
  };
  /**
   * NULL without `wages.view`. The headcount and today's muster above are for whoever runs
   * the floor; what everybody is owed is a separate permission, so this block is withheld
   * whole — a payable of zero would be a claim rather than an absence.
   */
  money: {
    wagesAccrued: number;
    wagesPaid: number;
    workerDue: number;
    contractorDue: number;
    advanceOutstanding: number;
    statutoryDue: number;
    statutoryProvision: number;
    payable: number;
  } | null;
  wagesHidden?: boolean;
  unlinked: { partyName: string; billed: number; paid: number; balance: number }[];
  lastPosting: { id: number; number: string; periodFrom: string; periodTo: string } | null;
  topDue: { id: number; code: string; name: string; dueNow: number; earned: number }[];
  advances: { id: number; code: string; name: string; outstanding: number; recovered: number }[];
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

const get = async <T>(url: string, params?: Record<string, unknown>) => (await api.get<T>(url, { params })).data;

/** Everything a worker write can affect, including the shared money views. */
export const MANFORCE_KEYS = [
  ['manforce-summary'],
  ['workers'],
  ['worker'],
  ['muster'],
  ['worker-month'],
  ['statutory-preview'],
  ['statutory-postings'],
  ['statutory-components'],
  ['payables'],
  ['finance-summary'],
  ['finance-parties'],
  ['statement'],
  ['payments'],
  ['ops-dashboard'],
];

export const useManforceSummary = () => useQuery({ queryKey: ['manforce-summary'], queryFn: () => get<ManforceSummary>('/manforce/summary') });

export const useWorkers = (params: Record<string, unknown> = {}) => useQuery({ queryKey: ['workers', params], queryFn: () => get<Worker[]>('/workers', params) });

export const useWorker = (id?: number | string) =>
  useQuery({ enabled: id != null && id !== 'new', queryKey: ['worker', id], queryFn: () => get<WorkerDetail>(`/workers/${id}`) });

export const useMuster = (date: string) => useQuery({ queryKey: ['muster', date], queryFn: () => get<Muster>('/attendance', { date }) });

export const useWorkerMonth = (workerId?: number, month?: string) =>
  useQuery({ enabled: workerId != null, queryKey: ['worker-month', workerId, month], queryFn: () => get<WorkerMonth>(`/attendance/worker/${workerId}`, { month }) });

export const useTrades = () => useQuery({ queryKey: ['trades'], queryFn: () => get<Trade[]>('/trades') });
export const useContractors = () => useQuery({ queryKey: ['contractors'], queryFn: () => get<Contractor[]>('/contractors') });
export const useWorkforceSettings = () => useQuery({ queryKey: ['workforce-settings'], queryFn: () => get<WorkforceSettings>('/workforce/settings') });
export const useStatutoryComponents = () => useQuery({ queryKey: ['statutory-components'], queryFn: () => get<StatutoryComponent[]>('/statutory-components') });
export const useStatutoryPostings = () => useQuery({ queryKey: ['statutory-postings'], queryFn: () => get<StatutoryPosting[]>('/statutory/postings') });

export const useStatutoryPreview = (from?: string, to?: string, enabled = true) =>
  useQuery({
    enabled: enabled && !!from && !!to,
    queryKey: ['statutory-preview', from, to],
    queryFn: () => get<StatutoryPreview>('/statutory/preview', { from, to }),
  });

/** Upload a worker photo or ID scan. */
export async function uploadWorkerDocuments(workerId: number, files: File[], kind: 'PHOTO' | 'ID', label?: string) {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  form.append('kind', kind);
  if (label) form.append('label', label);
  return (await api.post(`/workers/${workerId}/documents`, form)).data;
}
