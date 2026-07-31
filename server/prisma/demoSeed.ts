/**
 * Investor demo data — a furniture export house caught mid-season.
 *
 * Rebuilds a coherent factory: a photographed catalogue with real costing, three
 * buyers in three currencies, proformas at every stage of the sales cycle, four
 * orders at different points of production (including outsourced stages and a QC
 * rejection), and a money position that ties back to all of it.
 *
 *   npm run db:demo
 *
 * Safe to re-run: it clears operational data first, then rebuilds from scratch.
 * Configuration (logins, currencies, units, attributes, cost formulas, stage lines)
 * is created if missing and otherwise left alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { BUILTIN_METHODS, round } from '../src/lib/costing';
import { computeCostSheet } from '../src/lib/productCosting';
import { loadMethodMap } from '../src/lib/methods';
import { seedManforceDefaults } from './manforceSeed';
import { documentValueOf } from '../src/lib/pricing';
import { ensureCompany } from '../src/lib/company';
import { buildBoard } from '../src/lib/production';
import { syncOrderStatus } from '../src/lib/orderBoard';
import { wipeOperational as wipe } from './wipe';

const prisma = new PrismaClient();

const ASSETS = path.join(__dirname, 'demo', 'assets');
const UPLOADS = path.join(__dirname, '..', 'uploads');

const YEAR = new Date().getFullYear();
/** Days before today, so the demo always looks current. */
const ago = (days: number, hour = 10) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, 0, 0, 0);
  return d;
};

// ---------------------------------------------------------------------------
// Costing helpers — parts are derived from the piece's own dimensions, so the
// numbers move sensibly from one product to the next instead of being invented.
// ---------------------------------------------------------------------------

type Line = Record<string, unknown>;
const L = (name: string, opts: Partial<{ qty: number; wastagePct: number; actualL: number; actualW: number; actualH: number; costL: number; costW: number; costH: number; actualWeight: number; unit: string; rate: number }>): Line => ({
  name,
  qty: 1,
  wastagePct: 0,
  ...opts,
});

/** A solid-wood carcass cut from the product's own L/W/H, in CFT. */
function carcass(material: string, rate: number, dims: { l: number; w: number; h: number }, shelves = 2): Line {
  const { l, w, h } = dims;
  const pad = (v: number, f = 1.08) => round(v * f, 1);
  return {
    head: 'MAIN_COMPONENT',
    name: material,
    method: 'CFT',
    dimUnit: 'IN',
    sortOrder: 0,
    lines: {
      create: [
        L('TOP', { actualL: l, actualW: w, actualH: 1.2, costL: pad(l), costW: pad(w, 1.2), costH: 1.2, qty: 1, wastagePct: 20, rate, unit: 'CFT' }),
        L('SIDE PANEL', { actualL: h, actualW: w, actualH: 1, costL: pad(h), costW: pad(w, 1.2), costH: 1, qty: 2, wastagePct: 20, rate, unit: 'CFT' }),
        L('BOTTOM', { actualL: l - 2, actualW: w - 1, actualH: 1, costL: pad(l - 2), costW: pad(w - 1, 1.2), costH: 1, qty: 1, wastagePct: 20, rate, unit: 'CFT' }),
        L('SHELF', { actualL: l - 3, actualW: w - 2, actualH: 0.8, costL: pad(l - 3), costW: pad(w - 2, 1.2), costH: 0.8, qty: shelves, wastagePct: 20, rate, unit: 'CFT' }),
        L('DOOR FRAME', { actualL: h - 6, actualW: 3.5, actualH: 1.2, costL: pad(h - 6), costW: 4.2, costH: 1.2, qty: 4, wastagePct: 18, rate, unit: 'CFT' }),
        L('BACK RAIL', { actualL: l - 2, actualW: 3, actualH: 1, costL: pad(l - 2), costW: 3.6, costH: 1, qty: 2, wastagePct: 15, rate, unit: 'CFT' }),
      ],
    },
  };
}

const plyBack = (l: number, h: number, rate = 32): Line => ({
  head: 'SUB_COMPONENT',
  name: 'Ply 6mm',
  method: 'SQFT',
  dimUnit: 'IN',
  sortOrder: 0,
  lines: { create: [L('BACK PANEL', { actualL: l, actualW: h, costL: l, costW: h, qty: 1, rate, unit: 'SQFT' }), L('DRAWER BASE', { actualL: 18, actualW: 14, costL: 18, costW: 14, qty: 3, rate, unit: 'SQFT' })] },
});

const ironFrame = (kg: number, rate = 195): Line => ({
  head: 'SUB_COMPONENT',
  name: 'Iron — powder-coated frame',
  method: 'WEIGHT',
  sortOrder: 1,
  lines: { create: [L('BASE FRAME / LEGS', { actualWeight: kg, wastagePct: 4, qty: 1, rate, unit: 'KGS' })] },
});

const glassPanel = (n: number, l: number, w: number, rate = 140): Line => ({
  head: 'SUB_COMPONENT',
  name: 'Glass 4mm',
  method: 'SQFT',
  dimUnit: 'IN',
  sortOrder: 2,
  lines: { create: [L('DOOR GLASS', { actualL: l, actualW: w, costL: l, costW: w, qty: n, rate, unit: 'SQFT' })] },
});

const tileInlay = (n: number, rate = 34): Line => ({
  head: 'SUB_COMPONENT',
  name: 'Hand-painted ceramic tiles',
  method: 'QTY',
  sortOrder: 3,
  lines: { create: [L('4x4 PAINTED TILE', { qty: n, rate, unit: 'PCS' })] },
});

const hardware = (scale = 1): Line => ({
  head: 'HARDWARE',
  name: 'Hardware',
  method: 'QTY',
  sortOrder: 0,
  lines: {
    create: [
      L('BRASS CUP HANDLE', { qty: Math.round(4 * scale), rate: 78, unit: 'PCS' }),
      L('CONCEALED HINGE', { qty: Math.round(6 * scale), rate: 46, unit: 'PCS' }),
      L('DRAWER SLIDE PAIR', { qty: Math.round(3 * scale), rate: 165, unit: 'SET' }),
      L("1.5' SCREW", { qty: Math.round(48 * scale), rate: 0.85, unit: 'PCS' }),
      L('FELT PAD', { qty: 4, rate: 6, unit: 'PCS' }),
      L('SANDING PAPER 120N', { qty: Math.round(4 * scale), rate: 39, unit: 'PCS' }),
    ],
  },
});

const polishing = (scale = 1): Line => ({
  head: 'POLISHING',
  name: 'Polishing',
  method: 'QTY',
  sortOrder: 0,
  lines: {
    create: [
      L('WOOD STAIN', { qty: round(1.4 * scale, 2), rate: 240, unit: 'LTR' }),
      L('SEALER', { qty: round(1.2 * scale, 2), rate: 210, unit: 'LTR' }),
      L('MATT LACQUER', { qty: round(1.6 * scale, 2), rate: 265, unit: 'LTR' }),
      L('THINNER', { qty: round(2.0 * scale, 2), rate: 92, unit: 'LTR' }),
      L('RUBBING CLOTH', { qty: 3, rate: 9, unit: 'PCS' }),
    ],
  },
});

const packaging = (cbm: number): Line => ({
  head: 'PACKAGING',
  name: 'Packaging',
  method: 'QTY',
  sortOrder: 0,
  lines: {
    create: [
      L('BUBBLE WRAP', { qty: round(cbm * 9, 2), rate: 34, unit: 'MTR' }),
      L('EPE FOAM', { qty: round(cbm * 7, 2), rate: 41, unit: 'MTR' }),
      L('7-PLY EXPORT CARTON', { qty: 1, rate: round(430 + cbm * 320), unit: 'PCS' }),
      L('EDGE PROTECTOR', { qty: 8, rate: 3.2, unit: 'PCS' }),
      L('STRAPPING + STICKERS', { qty: 1, rate: 46, unit: 'LOT' }),
    ],
  },
});

const labour = (scale = 1, extra?: [string, number]): Line => ({
  head: 'LABOUR',
  name: 'Labour',
  method: 'QTY',
  sortOrder: 0,
  lines: {
    create: [
      L('CNC / CUTTING', { qty: 1, rate: round(120 * scale), unit: 'LOT' }),
      L('CARCASS ASSEMBLY', { qty: 1, rate: round(430 * scale), unit: 'LOT' }),
      L('SANDING', { qty: 1, rate: round(210 * scale), unit: 'LOT' }),
      L('POLISHING LABOUR', { qty: 1, rate: round(390 * scale), unit: 'LOT' }),
      L('FITTING & QC', { qty: 1, rate: round(180 * scale), unit: 'LOT' }),
      L('PACKING LABOUR', { qty: 1, rate: round(165 * scale), unit: 'LOT' }),
      ...(extra ? [L(extra[0], { qty: 1, rate: extra[1], unit: 'LOT' })] : []),
    ],
  },
});

const forwarding = (cbm: number): Line => ({
  head: 'FORWARDING',
  name: 'Forwarding',
  method: 'QTY',
  sortOrder: 0,
  lines: {
    create: [
      L('CHA CHARGES', { qty: 1, rate: round(90 + cbm * 60), unit: 'LOT' }),
      L('INLAND FREIGHT (ICD)', { qty: 1, rate: round(140 + cbm * 210), unit: 'LOT' }),
      L('FORWARDER / BL', { qty: 1, rate: round(320 + cbm * 480), unit: 'LOT' }),
    ],
  },
});

// ---------------------------------------------------------------------------

interface ProductDef {
  code: string;
  name: string;
  alias: string;
  image: string;
  description: string;
  type: string;
  size: string;
  colour: string;
  material: string;
  finish: string;
  itemType: string;
  stageLine: 'X' | 'Y';
  dims: { l: number; w: number; h: number };
  pack: { l: number; w: number; h: number };
  weight: [number, number];
  buyer: 'AB' | 'HG' | 'MW';
  buyerCode: string;
  groups: (methodDims: { l: number; w: number; h: number }, cbm: number) => Line[];
}

const PRODUCTS: ProductDef[] = [
  {
    code: 'AB-2101',
    name: 'Aurora Two-Tone Sideboard',
    alias: 'Aurora 2-Door Sideboard',
    image: 'aurora-two-tone-sideboard.jpg',
    description: 'Two-door mango wood sideboard with a marble-effect two-tone front, brass cup handles and a black powder-coated iron splay base.',
    type: 'Cabinet',
    size: 'Medium',
    colour: 'Natural',
    material: 'Mango Wood',
    finish: 'Matt',
    itemType: 'Knock-Down (KD)',
    stageLine: 'Y',
    dims: { l: 47, w: 16, h: 30 },
    pack: { l: 51, w: 20, h: 34 },
    weight: [38, 46],
    buyer: 'AB',
    buyerCode: 'AUR-SB-47',
    groups: (d, cbm) => [carcass('Mango Wood', 620, d, 1), plyBack(30, 45), ironFrame(9.5), hardware(0.9), polishing(0.9), packaging(cbm), labour(0.95), forwarding(cbm)],
  },
  {
    code: 'AB-2102',
    name: 'Aurora Striped Console',
    alias: 'Aurora Striped 2-Door',
    image: 'aurora-striped-console.jpg',
    description: 'Companion piece to the Aurora sideboard — banded light and dark mango fronts on a slim powder-coated base, sized for a hallway.',
    type: 'Side Table',
    size: 'Small',
    colour: 'Natural',
    material: 'Mango Wood',
    finish: 'Matt',
    itemType: 'Knock-Down (KD)',
    stageLine: 'Y',
    dims: { l: 36, w: 15, h: 30 },
    pack: { l: 40, w: 19, h: 34 },
    weight: [29, 35],
    buyer: 'AB',
    buyerCode: 'AUR-CN-36',
    groups: (d, cbm) => [carcass('Mango Wood', 620, d, 1), plyBack(30, 34), ironFrame(7.5), hardware(0.7), polishing(0.75), packaging(cbm), labour(0.8), forwarding(cbm)],
  },
  {
    code: 'HG-2201',
    name: 'Jaipur Tiled Sideboard',
    alias: 'Jaipur 3-Door Tiled',
    image: 'jaipur-tiled-sideboard.jpg',
    description: 'Distressed-white three-door sideboard inset with 27 hand-painted Jaipur ceramic tiles. Three top drawers, solid mango carcass.',
    type: 'Cabinet',
    size: 'Large',
    colour: 'Distressed White',
    material: 'Mango Wood',
    finish: 'Distressed',
    itemType: 'Finished Furniture',
    stageLine: 'X',
    dims: { l: 59, w: 16, h: 34 },
    pack: { l: 63, w: 20, h: 38 },
    weight: [52, 61],
    buyer: 'HG',
    buyerCode: 'JAI-SB-60',
    groups: (d, cbm) => [carcass('Mango Wood', 585, d, 2), plyBack(34, 57), tileInlay(27), hardware(1.15), polishing(1.2), packaging(cbm), labour(1.2, ['TILE SETTING', 340]), forwarding(cbm)],
  },
  {
    code: 'HG-2202',
    name: 'Jaipur Tiled Tall Cabinet',
    alias: 'Jaipur Tall Tiled',
    image: 'jaipur-tiled-tall-cabinet.jpg',
    description: 'Tall two-door version of the Jaipur range with 40 hand-painted tiles across full-height doors and four internal shelves.',
    type: 'Almirah',
    size: 'Large',
    colour: 'Distressed White',
    material: 'Mango Wood',
    finish: 'Distressed',
    itemType: 'Finished Furniture',
    stageLine: 'X',
    dims: { l: 32, w: 15, h: 66 },
    pack: { l: 36, w: 19, h: 70 },
    weight: [58, 68],
    buyer: 'HG',
    buyerCode: 'JAI-TC-66',
    groups: (d, cbm) => [carcass('Mango Wood', 585, d, 4), plyBack(66, 30), tileInlay(40), hardware(1.1), polishing(1.3), packaging(cbm), labour(1.3, ['TILE SETTING', 480]), forwarding(cbm)],
  },
  {
    code: 'MW-2301',
    name: 'Heritage Display Hutch',
    alias: 'Heritage Glazed Hutch',
    image: 'heritage-display-hutch.jpg',
    description: 'Two-piece glazed display hutch in solid acacia: sliding-glass upper deck over a four-door base with a woven rattan basket bay.',
    type: 'Bookshelf',
    size: 'XL',
    colour: 'Honey',
    material: 'Oak Wood',
    finish: 'Natural Wax',
    itemType: 'Knock-Down (KD)',
    stageLine: 'X',
    dims: { l: 63, w: 18, h: 78 },
    pack: { l: 67, w: 22, h: 44 },
    weight: [86, 99],
    buyer: 'MW',
    buyerCode: 'HER-HU-63',
    groups: (d, cbm) => [carcass('Oak Wood', 740, d, 4), plyBack(78, 61), glassPanel(4, 26, 22), hardware(1.5), polishing(1.5), packaging(cbm), labour(1.6, ['GLAZING', 420]), forwarding(cbm)],
  },
  {
    code: 'AB-2401',
    name: 'Sunburst Marquetry Sideboard',
    alias: 'Sunburst 3-Door',
    image: 'sunburst-marquetry-sideboard.jpg',
    description: 'Three-door sideboard with hand-laid radial marquetry in reclaimed sheesham across every front, on a slim black iron plinth.',
    type: 'Cabinet',
    size: 'Large',
    colour: 'Walnut',
    material: 'Sheesham',
    finish: 'Glossy',
    itemType: 'Finished Furniture',
    stageLine: 'Y',
    dims: { l: 67, w: 17, h: 31 },
    pack: { l: 71, w: 21, h: 35 },
    weight: [61, 71],
    buyer: 'AB',
    buyerCode: 'SUN-SB-67',
    groups: (d, cbm) => [carcass('Sheesham', 890, d, 2), plyBack(31, 65), ironFrame(11.5), hardware(1.2), polishing(1.45), packaging(cbm), labour(1.5, ['MARQUETRY INLAY', 1150]), forwarding(cbm)],
  },
  {
    code: 'MW-2501',
    name: 'Mandala Carved Almirah',
    alias: 'Mandala 2-Door Almirah',
    image: 'mandala-carved-almirah.jpg',
    description: 'Two-door almirah with a deep hand-carved mandala spanning both doors, brass ring pulls and a single internal hanging rail.',
    type: 'Almirah',
    size: 'Large',
    colour: 'Honey',
    material: 'Mango Wood',
    finish: 'Natural Wax',
    itemType: 'Finished Furniture',
    stageLine: 'X',
    dims: { l: 36, w: 18, h: 72 },
    pack: { l: 40, w: 22, h: 76 },
    weight: [64, 74],
    buyer: 'MW',
    buyerCode: 'MAN-AL-72',
    groups: (d, cbm) => [carcass('Mango Wood', 640, d, 3), plyBack(72, 34), hardware(1.05), polishing(1.35), packaging(cbm), labour(1.35, ['HAND CARVING', 1450]), forwarding(cbm)],
  },
  {
    code: 'HG-2601',
    name: 'Nordic Mango Sideboard',
    alias: 'Nordic 4-Door Low',
    image: 'nordic-mango-sideboard.jpg',
    description: 'Low four-door sideboard in pale mango with book-matched grain fronts on tapered black steel legs. Flat-packs for container efficiency.',
    type: 'Cabinet',
    size: 'Large',
    colour: 'Natural',
    material: 'Mango Wood',
    finish: 'Matt',
    itemType: 'Knock-Down (KD)',
    stageLine: 'Y',
    dims: { l: 71, w: 15, h: 28 },
    pack: { l: 75, w: 19, h: 20 },
    weight: [49, 58],
    buyer: 'HG',
    buyerCode: 'NOR-SB-71',
    groups: (d, cbm) => [carcass('Mango Wood', 605, d, 1), plyBack(28, 69), ironFrame(8.5), hardware(1.1), polishing(1.1), packaging(cbm), labour(1.05), forwarding(cbm)],
  },
  {
    code: 'MW-2701',
    name: 'Rustic Dining Hutch',
    alias: 'Rustic Glazed Dining Set Hutch',
    image: 'rustic-dining-hutch.jpg',
    description: 'Wide glazed dining hutch in reclaimed pine with six drawers, twin display decks and antique-iron drop handles.',
    type: 'Bookshelf',
    size: 'XL',
    colour: 'Honey',
    material: 'Oak Wood',
    finish: 'Distressed',
    itemType: 'Knock-Down (KD)',
    stageLine: 'X',
    dims: { l: 67, w: 19, h: 82 },
    pack: { l: 71, w: 23, h: 46 },
    weight: [94, 108],
    buyer: 'MW',
    buyerCode: 'RUS-HU-67',
    groups: (d, cbm) => [carcass('Oak Wood', 705, d, 5), plyBack(82, 65), glassPanel(6, 22, 20), hardware(1.7), polishing(1.6), packaging(cbm), labour(1.75, ['GLAZING', 520]), forwarding(cbm)],
  },
  {
    code: 'AB-2801',
    name: 'Herringbone Reclaimed Console',
    alias: 'Herringbone 2-Door',
    image: 'herringbone-reclaimed-console.jpg',
    description: 'Two-door console with a herringbone front laid from reclaimed railway sheesham, each panel a different tone, on a black iron plinth.',
    type: 'Side Table',
    size: 'Medium',
    colour: 'Walnut',
    material: 'Sheesham',
    finish: 'Matt',
    itemType: 'Finished Furniture',
    stageLine: 'Y',
    dims: { l: 55, w: 16, h: 30 },
    pack: { l: 59, w: 20, h: 34 },
    weight: [47, 55],
    buyer: 'AB',
    buyerCode: 'HER-CN-55',
    groups: (d, cbm) => [carcass('Sheesham', 860, d, 1), plyBack(30, 53), ironFrame(10), hardware(1), polishing(1.2), packaging(cbm), labour(1.3, ['HERRINGBONE LAY-UP', 890]), forwarding(cbm)],
  },
];

const CBM_PER_CUBIC_INCH = 0.0000163871;
const cbmOf = (d: { l: number; w: number; h: number }) => round(d.l * d.w * d.h * CBM_PER_CUBIC_INCH, 4);

// ---------------------------------------------------------------------------
// The workforce
// ---------------------------------------------------------------------------

/** Trades, a gang, eight workers, some exceptions on the muster, and their money. */
async function seedWorkforce(adminId: number) {
  await seedManforceDefaults(prisma);
  const trades = await prisma.trade.findMany();
  const tradeId = (name: string) => trades.find((t) => t.name === name)?.id ?? null;
  const components = await prisma.statutoryComponent.findMany();
  const componentId = (code: string) => components.find((c) => c.code === code)!.id;

  const contractor = await prisma.contractor.create({
    data: { code: 'CTR-0001', name: 'Ismail Bhai (gang)', contactName: 'Ismail Khan', phone: '98290 11223', paymentTerms: 'Settled weekly, cash', notes: 'Supplies helpers for sanding and packing.' },
  });

  const defs = [
    { name: 'Ramesh Suthar', trade: 'Carpenter', payType: 'DAY', dailyRate: 750, otHourlyRate: 190, phone: '98280 45511', joined: 400, cover: ['PF', 'ESI'] },
    { name: 'Mahesh Jangid', trade: 'Polisher', payType: 'PIECE', phone: '99280 77341', joined: 260, cover: ['ESI'] },
    { name: 'Suresh Prajapat', trade: 'Sander', payType: 'DAY', dailyRate: 620, phone: '94140 22190', joined: 210, cover: ['ESI'] },
    { name: 'Kailash Meghwal', trade: 'Packer', payType: 'DAY', dailyRate: 560, joined: 150, cover: [] },
    { name: 'Dinesh Khatri', trade: 'Fitter', payType: 'PIECE', phone: '90240 55178', joined: 120, cover: [] },
    { name: 'Gopal Vishnoi', trade: 'Supervisor', payType: 'MONTHLY', monthlySalary: 27000, phone: '90010 33456', joined: 520, cover: ['PF'] },
    { name: 'Pooja Devi', trade: 'Helper', payType: 'DAY', dailyRate: 480, joined: 95, gang: true, cover: [] },
    { name: 'Bhanwar Lal', trade: 'Helper', payType: 'DAY', dailyRate: 480, joined: 80, gang: true, cover: [] },
  ] as const;

  const workers: Record<string, number> = {};
  let n = 0;
  for (const d of defs) {
    const w = await prisma.worker.create({
      data: {
        code: `WRK-${String(++n).padStart(4, '0')}`,
        name: d.name,
        tradeId: tradeId(d.trade),
        contractorId: 'gang' in d && d.gang ? contractor.id : null,
        payType: d.payType,
        dailyRate: 'dailyRate' in d ? d.dailyRate : 0,
        otHourlyRate: 'otHourlyRate' in d ? d.otHourlyRate : 0,
        monthlySalary: 'monthlySalary' in d ? d.monthlySalary : 0,
        phone: 'phone' in d ? d.phone : null,
        joinedOn: ago(d.joined),
        createdById: adminId,
      },
    });
    workers[d.name] = w.id;
    for (const code of d.cover) {
      await prisma.workerStatutory.create({ data: { workerId: w.id, componentId: componentId(code), covered: true } });
    }
  }
  await prisma.docSequence.update({ where: { key: 'WRK' }, data: { lastNo: n } });
  await prisma.docSequence.update({ where: { key: 'CTR' }, data: { lastNo: 1 } });

  // A handful of exceptions — the rest of the calendar is presumed present.
  const mark = (name: string, days: number, status: string, otHours = 0, note?: string) => {
    const d = ago(days);
    return prisma.attendance.create({
      data: { workerId: workers[name], date: new Date(d.getFullYear(), d.getMonth(), d.getDate()), status, otHours, note: note ?? null, createdById: adminId },
    });
  };
  await mark('Kailash Meghwal', 2, 'ABSENT', 0, 'Family function');
  await mark('Suresh Prajapat', 3, 'HALF_DAY', 0, 'Left after lunch');
  await mark('Ramesh Suthar', 3, 'PRESENT', 3, 'Stayed back for the QC lot');
  await mark('Bhanwar Lal', 4, 'LEAVE', 0, 'Unpaid — village');
  await mark('Pooja Devi', 5, 'PAID_LEAVE', 0, 'Approved');
  await mark('Ramesh Suthar', 9, 'PRESENT', 2, 'Overtime on the almirah doors');
  await mark('Gopal Vishnoi', 10, 'ABSENT', 0, 'Sick');

  // Piece rates on the in-house stages that have actually cleared pieces, then name
  // who did the work. Priced off the board, exactly as jobwork is.
  const RATES: Record<string, number> = { 'Raw joining': 55, 'Raw sanding': 30, 'Accessory fitting': 45, Packaging: 22, Packing: 22 };
  const stages = await prisma.orderLineStage.findMany({ where: { vendorId: null, name: { in: Object.keys(RATES) } } });
  for (const s of stages) await prisma.orderLineStage.update({ where: { id: s.id }, data: { labourRate: RATES[s.name] } });

  const crews: Record<string, string[]> = {
    'Raw joining': ['Ramesh Suthar'],
    'Raw sanding': ['Suresh Prajapat', 'Pooja Devi'],
    'Accessory fitting': ['Dinesh Khatri'],
    Packaging: ['Kailash Meghwal', 'Bhanwar Lal'],
    Packing: ['Kailash Meghwal'],
  };
  const stageById = new Map(stages.map((s) => [s.id, s]));
  const cleared = await prisma.stageMove.findMany({ where: { kind: { in: ['ADVANCE', 'COMPLETE'] }, fromStageId: { in: stages.map((s) => s.id) } } });
  let attributed = 0;
  for (const move of cleared) {
    const stage = stageById.get(move.fromStageId!);
    const crew = stage ? crews[stage.name] ?? [] : [];
    if (!crew.length) continue;
    // Split the pieces across the crew, remainder to the first of them, so the counts
    // always add up to the movement exactly.
    const each = Math.floor(move.qty / crew.length);
    const split = crew.map((_, i) => (i === 0 ? move.qty - each * (crew.length - 1) : each)).filter((q) => q > 0);
    if (split.reduce((a, q) => a + q, 0) !== move.qty) continue;
    for (const [i, pieces] of split.entries()) {
      await prisma.stageMoveWorker.create({ data: { moveId: move.id, workerId: workers[crew[i]], pieces } });
    }
    attributed++;
  }

  // Money: one part payment, one capped advance still being worked off, one charge
  // back, and a payment to the gang.
  const pay = (name: string, amount: number, days: number, note: string, ref?: string) =>
    prisma.ledgerEntry.create({
      data: { partyType: 'WORKER', workerId: workers[name], partyName: name, kind: 'PAYMENT', amount, currency: 'INR', date: ago(days), ref: ref ?? null, note, createdById: adminId },
    });
  await pay('Ramesh Suthar', 240000, 12, 'Wages on account', 'UPI-88213');
  await pay('Kailash Meghwal', 60000, 9, 'Wages on account', 'CASH');
  await pay('Gopal Vishnoi', 180000, 15, 'Salary on account', 'NEFT');

  const advance = await prisma.workerAdvance.create({
    data: { workerId: workers['Suresh Prajapat'], amount: 8000, date: ago(40), recoveryPerMonth: 1500, note: 'Advance for a wedding', createdById: adminId },
  });
  await prisma.ledgerEntry.create({
    data: { partyType: 'WORKER', workerId: workers['Suresh Prajapat'], partyName: 'Suresh Prajapat', kind: 'PAYMENT', amount: 8000, currency: 'INR', date: ago(40), note: 'Advance for a wedding', advanceId: advance.id, createdById: adminId },
  });
  await prisma.workerDeduction.create({ data: { workerId: workers['Kailash Meghwal'], amount: 320, reason: 'Canteen', date: ago(6), createdById: adminId } });
  await prisma.workerDeduction.create({ data: { workerId: workers['Dinesh Khatri'], amount: 750, reason: 'Damaged glass panel', date: ago(18), createdById: adminId } });

  await prisma.ledgerEntry.create({
    data: { partyType: 'CONTRACTOR', contractorId: contractor.id, partyName: contractor.name, kind: 'PAYMENT', amount: 45000, currency: 'INR', date: ago(11), ref: 'CASH', note: 'Part payment to the gang', createdById: adminId },
  });

  console.log(`  ${defs.length} workers (1 gang of 2), ${attributed} clearances attributed, wages left derived`);
}

// ---------------------------------------------------------------------------

/** Shared with `db:clean` — see `wipe.ts` for what counts as operational and why. */
const wipeOperational = () => wipe(prisma);

async function ensureConfig() {
  // The demo advertises these two logins, so it ENFORCES them rather than upserting
  // with an empty update — a drifted role or password would otherwise leave the demo
  // unopenable at exactly the wrong moment.
  const logins = [
    { email: 'admin@saraswati.local', name: 'Administrator', role: 'Admin', password: 'admin123' },
    { email: 'manager@saraswati.local', name: 'Production Manager', role: 'Manager', password: 'manager123' },
  ];
  let admin!: { id: number };
  for (const l of logins) {
    const passwordHash = await bcrypt.hash(l.password, 10);
    const rec = await prisma.user.upsert({
      where: { email: l.email },
      update: { name: l.name, role: l.role, passwordHash, isActive: true },
      create: { name: l.name, email: l.email, role: l.role, passwordHash },
    });
    if (l.role === 'Admin') admin = rec;
  }

  for (const c of [
    { code: 'INR', name: 'Indian Rupee', symbol: '₹', rateToBase: 1, isBase: true },
    { code: 'USD', name: 'US Dollar', symbol: '$', rateToBase: 83.4, isBase: false },
    { code: 'EUR', name: 'Euro', symbol: '€', rateToBase: 90.2, isBase: false },
    { code: 'GBP', name: 'Pound Sterling', symbol: '£', rateToBase: 105.6, isBase: false },
  ]) {
    await prisma.currency.upsert({ where: { code: c.code }, update: { rateToBase: c.rateToBase, symbol: c.symbol, name: c.name, isBase: c.isBase }, create: c });
  }
  for (const m of BUILTIN_METHODS) await prisma.costMethod.upsert({ where: { code: m.code }, update: { ...m, isBuiltIn: true }, create: { ...m, isBuiltIn: true } });

  // Who we are. `state` is not decoration: it is what makes a Rajasthan buyer CGST+SGST
  // and a Maharashtra buyer IGST, so the demo sets it explicitly rather than defaulting.
  await ensureCompany();
  await prisma.company.update({
    where: { id: 1 },
    data: {
      legalName: 'Saraswati Export',
      tradeName: 'Furniture & Hardware Exporter',
      addressL1: 'Plot 44, Boranada Industrial Area',
      city: 'Jodhpur',
      state: 'Rajasthan',
      pincode: '342012',
      country: 'India',
      gstNo: '08ABCDE1234F1Z5',
      panNo: 'ABCDE1234F',
      iecNo: '0812345678',
      phone: '+91 291 2740 155',
      email: 'exports@saraswatiexport.in',
      bankDetails: 'Bank: State Bank of India, Sardarpura, Jodhpur\nA/C: 3812 4457 9910\nIFSC: SBIN0031234\nSWIFT: SBININBB245',
    },
  });

  const units = [['PCS', 'Pieces'], ['SET', 'Set'], ['KGS', 'Kilograms'], ['CFT', 'Cubic Feet'], ['SQFT', 'Square Feet'], ['SQM', 'Square Metre'], ['MTR', 'Metre'], ['LTR', 'Litre'], ['LOT', 'Lot']];
  for (let i = 0; i < units.length; i++) await prisma.unit.upsert({ where: { code: units[i][0] }, update: { name: units[i][1], sortOrder: i }, create: { code: units[i][0], name: units[i][1], sortOrder: i } });

  const attributes: Record<string, string[]> = {
    PRODUCT_TYPE: ['Almirah', 'Cabinet', 'Side Table', 'Dining Table', 'Chair', 'Bar Stool', 'Bench', 'Bookshelf'],
    ITEM_TYPE: ['Finished Furniture', 'Knock-Down (KD)', 'Hardware Fitting'],
    SIZE: ['Small', 'Medium', 'Large', 'XL'],
    COLOUR: ['Natural', 'Walnut', 'Distressed White', 'Black', 'Honey'],
    MATERIAL: ['Mango Wood', 'Oak Wood', 'Sheesham', 'Iron', 'Ply', 'Glass'],
    FINISH: ['Matt', 'Glossy', 'Distressed', 'Powder Coated', 'Natural Wax'],
  };
  const attrId: Record<string, Record<string, number>> = {};
  for (const [type, values] of Object.entries(attributes)) {
    attrId[type] = {};
    for (let i = 0; i < values.length; i++) {
      const rec = await prisma.attributeValue.upsert({ where: { type_value: { type, value: values[i] } }, update: { sortOrder: i }, create: { type, value: values[i], sortOrder: i } });
      attrId[type][values[i]] = rec.id;
    }
  }

  /** How long each stage usually takes, so a generated schedule is believable. */
  const STAGE_DAYS: Record<string, number> = { 'Raw joining': 4, 'Raw sanding': 2, 'Polishing': 3, 'Accessory fitting': 2, 'QC': 1, 'Packaging': 1, 'Powder coating': 3, 'Fitting': 2, 'Packing': 1};
  const stageLines = [
    { code: 'X', name: 'Wood line', isDefault: true, steps: ['Raw joining', 'Raw sanding', 'Polishing', 'Accessory fitting', 'QC', 'Packaging'] },
    { code: 'Y', name: 'Metal line', isDefault: false, steps: ['Raw joining', 'Powder coating', 'Fitting', 'QC', 'Packing'] },
  ];
  const lineId: Record<string, number> = {};
  for (const sl of stageLines) {
    const existing = await prisma.stageLine.findUnique({ where: { code: sl.code } });
    const rec = existing
      ? await prisma.stageLine.update({ where: { code: sl.code }, data: { name: sl.name, isDefault: sl.isDefault, isActive: true } })
      : await prisma.stageLine.create({ data: { code: sl.code, name: sl.name, isDefault: sl.isDefault } });
    await prisma.stageLineStep.deleteMany({ where: { stageLineId: rec.id } });
    for (let i = 0; i < sl.steps.length; i++) await prisma.stageLineStep.create({ data: { stageLineId: rec.id, name: sl.steps[i], sortOrder: i, defaultDays: STAGE_DAYS[sl.steps[i]] ?? null } });
    lineId[sl.code] = rec.id;
  }

  for (const s of [
    { key: 'PI', prefix: 'PI', useYear: true },
    { key: 'ORD', prefix: 'ORD', useYear: true },
    // Domestic paperwork is numbered independently of the export series.
    { key: 'DPI', prefix: 'DPI', useYear: true },
    { key: 'DORD', prefix: 'DORD', useYear: true },
    { key: 'OP', prefix: 'OP', useYear: false },
  ]) {
    await prisma.docSequence.upsert({ where: { key: s.key }, update: { prefix: s.prefix, useYear: s.useYear }, create: s });
  }

  return { admin, attrId, lineId };
}

async function main() {
  console.log('Building investor demo…\n');
  await wipeOperational();
  const { admin, attrId, lineId } = await ensureConfig();

  const inr = (await prisma.currency.findUnique({ where: { code: 'INR' } }))!;
  const usd = (await prisma.currency.findUnique({ where: { code: 'USD' } }))!;
  const eur = (await prisma.currency.findUnique({ where: { code: 'EUR' } }))!;
  const gbp = (await prisma.currency.findUnique({ where: { code: 'GBP' } }))!;
  const pcs = (await prisma.unit.findUnique({ where: { code: 'PCS' } }))!;

  // --- buyers -------------------------------------------------------------
  /** The optional fields only some demo buyers carry. */
  type DemoBuyer = { contactName?: string; email?: string; market?: string; channel?: string; state?: string; gstNo?: string };
  const buyerDefs = [
    { code: 'AB', name: 'Ashford & Barnes Ltd.', country: 'United Kingdom', contactName: 'James Ashford', email: 'buying@ashfordbarnes.co.uk', phone: '+44 20 7946 0112', address: 'Unit 14, Kingsland Trade Park\nLondon E8 4QN', currency: gbp },
    { code: 'HG', name: 'Heritage Home Goods', country: 'United States', contactName: 'Laura Chen', email: 'purchasing@heritagehome.com', phone: '+1 415 555 0184', address: '2200 Bayshore Blvd\nSan Francisco, CA 94134', currency: usd },
    { code: 'MW', name: 'Möbelwerk Hansa GmbH', country: 'Germany', contactName: 'Anke Brandt', email: 'einkauf@moebelwerk-hansa.de', phone: '+49 40 3199 2255', address: 'Speicherstadt 8\n20457 Hamburg', currency: eur },
    // --- domestic ---------------------------------------------------------
    // Trade, in our own state: the tax splits CGST + SGST.
    {
      code: 'JF', name: 'Jodhpur Furnishings', country: 'India', contactName: 'Mahendra Singh', email: 'orders@jodhpurfurnishings.in', phone: '+91 291 2510 880',
      address: '112 Sardarpura C Road\nJodhpur 342003', currency: inr, market: 'DOMESTIC', channel: 'B2B', state: 'Rajasthan', gstNo: '08AAFCJ4567K1Z9',
    },
    // Trade, another state: the identical money becomes IGST.
    {
      code: 'UD', name: 'Urban Decor Mumbai', country: 'India', contactName: 'Priya Nair', email: 'buying@urbandecor.in', phone: '+91 22 2673 4410',
      address: 'Unit 6, Kamala Mills\nLower Parel, Mumbai 400013', currency: inr, market: 'DOMESTIC', channel: 'B2B', state: 'Maharashtra', gstNo: '27AAGCU7788L1ZB',
    },
    // Retail: domestic B2C, no GSTIN.
    {
      code: 'WLK', name: 'Rekha Bhandari', country: 'India', phone: '+91 94140 33221',
      address: 'B-24 Shastri Nagar\nJodhpur 342003', currency: inr, market: 'DOMESTIC', channel: 'B2C', state: 'Rajasthan',
    },
  ];
  const buyers: Record<string, { id: number; name: string; currencyId: number; rate: number; market: string }> = {};
  for (const b of buyerDefs) {
    const rec = await prisma.buyer.create({
      data: {
        code: b.code,
        name: b.name,
        country: b.country,
        contactName: (b as DemoBuyer).contactName ?? null,
        email: (b as DemoBuyer).email ?? null,
        phone: b.phone,
        address: b.address,
        market: (b as DemoBuyer).market ?? 'OVERSEAS',
        channel: (b as DemoBuyer).channel ?? 'B2B',
        state: (b as DemoBuyer).state ?? null,
        gstNo: (b as DemoBuyer).gstNo ?? null,
      },
    });
    buyers[b.code] = { id: rec.id, name: rec.name, currencyId: b.currency.id, rate: b.currency.rateToBase, market: rec.market };
  }
  console.log(`  ${buyerDefs.length} buyers (${buyerDefs.filter((b) => (b as DemoBuyer).market === 'DOMESTIC').length} domestic)`);

  // --- suppliers ----------------------------------------------------------
  const supplierDefs = [
    { code: 'SUP-TIMBER', name: 'Sharma Timber Traders', type: 'MATERIAL', contactName: 'Ramesh Sharma', phone: '+91 98290 11111', gstNo: '08ABCDE1234F1Z5', address: 'Timber Market, Jodhpur', paymentTerms: '30 days' },
    { code: 'SUP-PLY', name: 'Rajasthan Ply & Board', type: 'MATERIAL', contactName: 'Vinod Agarwal', phone: '+91 98290 22222', gstNo: '08PLYRB4321K1Z9', address: 'Boranada, Jodhpur', paymentTerms: '21 days' },
    { code: 'SUP-METAL', name: 'Metal Craft Works', type: 'MATERIAL', contactName: 'Iqbal Khan', phone: '+91 98290 33333', gstNo: '08MNOPQ5678R1Z2', address: 'Industrial Area Phase II, Jodhpur', paymentTerms: '15 days' },
    { code: 'SUP-GLASS', name: 'Jodhpur Glass House', type: 'MATERIAL', contactName: 'Suresh Jain', phone: '+91 98290 44444', gstNo: '08GLSSH8899T1Z4', address: 'Sardarpura, Jodhpur', paymentTerms: '15 days' },
    { code: 'SUP-HDW', name: 'Shree Hardware Mart', type: 'MATERIAL', contactName: 'Dinesh Soni', phone: '+91 98290 55555', gstNo: '08HDWRE2211M1Z7', address: 'Nai Sarak, Jodhpur', paymentTerms: '30 days' },
    { code: 'JOB-POLISH', name: 'Glaze Polishing Co.', type: 'JOBWORK', contactName: 'Mahesh Prajapat', phone: '+91 98290 66666', gstNo: '08GLZPL3344P1Z1', address: 'Basni Phase I, Jodhpur', paymentTerms: 'On delivery' },
    { code: 'JOB-POWDER', name: 'Shakti Powder Coating', type: 'JOBWORK', contactName: 'Vikram Singh', phone: '+91 98290 77777', gstNo: '08SHKPC7788L1Z6', address: 'Boranada, Jodhpur', paymentTerms: '15 days' },
    { code: 'JOB-CARVE', name: 'Precision Carving Works', type: 'JOBWORK', contactName: 'Mohan Lal', phone: '+91 98290 88888', address: 'Nagauri Gate, Jodhpur', paymentTerms: 'On delivery' },
    { code: 'JOB-TILE', name: 'Marigold Tile Studio', type: 'JOBWORK', contactName: 'Pooja Rathore', phone: '+91 98290 99999', address: 'Pal Road, Jodhpur', paymentTerms: '15 days' },
  ];
  const sup: Record<string, number> = {};
  for (const s of supplierDefs) sup[s.code] = (await prisma.supplier.create({ data: s })).id;
  console.log(`  ${supplierDefs.length} suppliers`);

  // --- raw items + stock --------------------------------------------------
  const rawDefs = [
    { code: 'RM-MANGO', name: 'Mango Wood', category: 'Wood', unit: 'CFT', reorderLevel: 60, openingQty: 240 },
    { code: 'RM-OAK', name: 'Acacia / Oak Wood', category: 'Wood', unit: 'CFT', reorderLevel: 40, openingQty: 130 },
    { code: 'RM-SHEESHAM', name: 'Reclaimed Sheesham', category: 'Wood', unit: 'CFT', reorderLevel: 30, openingQty: 74 },
    { code: 'RM-PLY6', name: 'Ply 6mm', category: 'Ply', unit: 'SQFT', reorderLevel: 300, openingQty: 820 },
    { code: 'RM-IRON', name: 'MS Iron Section', category: 'Metal', unit: 'KGS', reorderLevel: 150, openingQty: 460 },
    { code: 'RM-GLASS', name: 'Glass 4mm', category: 'Glass', unit: 'SQFT', reorderLevel: 60, openingQty: 42 },
    { code: 'RM-TILE', name: 'Hand-painted Tile 4x4', category: 'Ceramic', unit: 'PCS', reorderLevel: 400, openingQty: 1250 },
    { code: 'RM-LACQ', name: 'Matt Lacquer', category: 'Polish', unit: 'LTR', reorderLevel: 80, openingQty: 62 },
  ];
  const raw: Record<string, number> = {};
  for (const r of rawDefs) raw[r.code] = (await prisma.rawItem.create({ data: r })).id;

  const stockDefs = [
    { code: 'RM-MANGO', type: 'IN', qty: 120, rate: 612, supplier: 'SUP-TIMBER', days: 47, note: 'Seasoned mango, 22 nos logs' },
    { code: 'RM-SHEESHAM', type: 'IN', qty: 46, rate: 875, supplier: 'SUP-TIMBER', days: 33, note: 'Reclaimed railway sleeper stock' },
    { code: 'RM-IRON', type: 'IN', qty: 240, rate: 92, supplier: 'SUP-METAL', days: 30, note: '25x25 MS square section' },
    { code: 'RM-PLY6', type: 'IN', qty: 600, rate: 31, supplier: 'SUP-PLY', days: 26, note: '8x4 sheets, 24 nos' },
    { code: 'RM-TILE', type: 'IN', qty: 900, rate: 33, supplier: 'JOB-TILE', days: 24, note: 'Blue-yellow floral, 4x4' },
    { code: 'RM-GLASS', type: 'IN', qty: 60, rate: 138, supplier: 'SUP-GLASS', days: 12, note: '4mm clear, cut to size' },
    { code: 'RM-MANGO', type: 'OUT', qty: 96, rate: 0, days: 40, note: 'Issued to Aurora + Nordic batches' },
    { code: 'RM-SHEESHAM', type: 'OUT', qty: 38, rate: 0, days: 22, note: 'Issued to Sunburst batch' },
    { code: 'RM-IRON', type: 'OUT', qty: 185, rate: 0, days: 21, note: 'Issued for powder coating' },
    { code: 'RM-TILE', type: 'OUT', qty: 780, rate: 0, days: 18, note: 'Issued to Jaipur range' },
  ];
  const stockIds: Record<string, number> = {};
  for (const s of stockDefs) {
    const rec = await prisma.stockTxn.create({
      data: { rawItemId: raw[s.code], type: s.type, qty: s.qty, rate: s.rate, supplierId: s.supplier ? sup[s.supplier] : null, note: s.note, date: ago(s.days), createdById: admin.id },
    });
    if (s.type === 'IN') stockIds[`${s.code}-${s.days}`] = rec.id;
  }
  console.log(`  ${rawDefs.length} raw items, ${stockDefs.length} stock movements`);

  // --- products -----------------------------------------------------------
  if (!fs.existsSync(ASSETS)) throw new Error(`Demo photos missing at ${ASSETS}`);
  fs.mkdirSync(UPLOADS, { recursive: true });

  const productIds: Record<string, number> = {};
  for (const p of PRODUCTS) {
    const cbm = cbmOf(p.pack);
    const created = await prisma.product.create({
      data: {
        factoryCode: p.code,
        name: p.name,
        alias: p.alias,
        status: 'Active',
        description: p.description,
        // Wooden furniture is HSN 9403 at 18%. Only used on domestic documents; an
        // export is zero-rated regardless.
        hsnCode: '9403',
        gstRatePct: 18,
        itemTypeId: attrId.ITEM_TYPE[p.itemType],
        productTypeId: attrId.PRODUCT_TYPE[p.type],
        sizeId: attrId.SIZE[p.size],
        colourId: attrId.COLOUR[p.colour],
        materialId: attrId.MATERIAL[p.material],
        finishId: attrId.FINISH[p.finish],
        unitId: pcs.id,
        stageLineId: lineId[p.stageLine],
        prodLengthIn: p.dims.l,
        prodWidthIn: p.dims.w,
        prodHeightIn: p.dims.h,
        netWeightKg: p.weight[0],
        grossWeightKg: p.weight[1],
        packLengthIn: p.pack.l,
        packWidthIn: p.pack.w,
        packHeightIn: p.pack.h,
        piecesPerCarton: 1,
        volumeBeforePackingCbm: cbmOf(p.dims),
        volumeAfterPackingCbm: cbm,
        createdById: admin.id,
        buyers: { create: [{ buyerId: buyers[p.buyer].id, buyerCode: p.buyerCode }] },
        costSheets: { create: [{ version: 1, isActive: true, currencyId: inr.id, factoryExpensePct: 15, marginPct: 18, groups: { create: p.groups(p.dims, cbm) as never } }] },
      },
    });
    productIds[p.code] = created.id;

    // Photo: copied into uploads and registered, exactly as an upload would be.
    const src = path.join(ASSETS, p.image);
    if (!fs.existsSync(src)) throw new Error(`Missing photo ${p.image}`);
    const filename = `demo-${p.code.toLowerCase()}-${p.image}`;
    fs.copyFileSync(src, path.join(UPLOADS, filename));
    await prisma.productImage.create({ data: { productId: created.id, filename, originalName: p.image, url: `/uploads/${filename}`, isPrimary: true, caption: p.name, sortOrder: 0 } });
  }
  // Map each product's LABOUR lines onto the stages of the route it travels. This is
  // REFERENCE only — it seeds the in-house piece rate when an order snapshots its
  // stages, and lets the costing wizard show what that stage really paid.
  const LABOUR_TO_STAGE: Record<string, string[]> = {
    'CNC / CUTTING': ['Raw joining'],
    'CARCASS ASSEMBLY': ['Raw joining'],
    SANDING: ['Raw sanding'],
    'POLISHING LABOUR': ['Polishing', 'Powder coating'],
    'FITTING & QC': ['Accessory fitting', 'Fitting'],
    'PACKING LABOUR': ['Packaging', 'Packing'],
  };
  let mapped = 0;
  for (const product of await prisma.product.findMany({ where: { stageLineId: { not: null } }, select: { id: true, stageLineId: true } })) {
    const steps = await prisma.stageLineStep.findMany({ where: { stageLineId: product.stageLineId! }, select: { id: true, name: true } });
    const lines = await prisma.costLine.findMany({ where: { group: { head: 'LABOUR', costSheet: { productId: product.id, isActive: true } } }, select: { id: true, name: true } });
    for (const l of lines) {
      const wanted = LABOUR_TO_STAGE[l.name] ?? [];
      const step = steps.find((s) => wanted.includes(s.name));
      if (!step) continue;
      await prisma.costLine.update({ where: { id: l.id }, data: { stageStepId: step.id } });
      mapped++;
    }
  }

  console.log(`  ${PRODUCTS.length} products with photos and costing, ${mapped} labour lines mapped to stages`);

  // Variants inside a collection.
  for (const [a, b] of [
    ['AB-2101', 'AB-2102'],
    ['HG-2201', 'HG-2202'],
  ]) {
    await prisma.relatedProduct.create({ data: { productId: productIds[a], relatedId: productIds[b], relation: 'VARIANT', note: 'Same collection, different size' } });
    await prisma.relatedProduct.create({ data: { productId: productIds[b], relatedId: productIds[a], relation: 'VARIANT', note: 'Same collection, different size' } });
  }

  // --- selling prices from the real costing engine -------------------------
  const methods = await loadMethodMap();
  const fobInr: Record<string, number> = {};
  const nonFobInr: Record<string, number> = {};
  for (const code of Object.keys(productIds)) {
    const full = await prisma.product.findUnique({ where: { id: productIds[code] }, include: { costSheets: { where: { isActive: true }, include: { groups: { include: { lines: true } } } } } });
    const computed = computeCostSheet(full?.costSheets?.[0], methods) as any;
    fobInr[code] = computed?.summary?.fob ?? 0;
    nonFobInr[code] = computed?.summary?.nonFob ?? 0;
  }
  /** Quoted price = FOB converted to the buyer's currency, nudged to a round number. */
  const priceIn = (code: string, rate: number, uplift = 1.06) => {
    const raw = (fobInr[code] / rate) * uplift;
    return Math.round(raw / 5) * 5;
  };
  /**
   * Domestic list price, in rupees, off Non-FOB — the same roll-up with the Forwarding
   * head (CHA, forwarder, ICD) excluded, because none of that applies to a lorry to
   * Mumbai. Uplifted a little more than export: retail carries more margin.
   */
  const domesticPrice = (code: string, uplift = 1.12) => Math.round((nonFobInr[code] * uplift) / 10) * 10;

  // --- proformas + orders -------------------------------------------------
  const ourStateSeed = (await prisma.company.findUnique({ where: { id: 1 } }))?.state ?? null;
  let piNo = 0;
  let ordNo = 0;
  let dpiNo = 0;
  let dordNo = 0;
  const nextPi = () => `PI-${YEAR}-${String(++piNo).padStart(4, '0')}`;
  const nextOrd = () => `ORD-${YEAR}-${String(++ordNo).padStart(4, '0')}`;
  // Domestic paperwork is numbered independently of the export series.
  const nextDpi = () => `DPI-${YEAR}-${String(++dpiNo).padStart(4, '0')}`;
  const nextDord = () => `DORD-${YEAR}-${String(++dordNo).padStart(4, '0')}`;

  interface PfLine { code: string; qty: number; discountPct?: number }
  type BuyerCode = 'AB' | 'HG' | 'MW' | 'JF' | 'UD' | 'WLK';
  interface ChargeDef { name: string; kind?: 'CHARGE' | 'DISCOUNT'; amount?: number; pct?: number; gstRatePct?: number; isTaxable?: boolean }
  async function makeProforma(opts: {
    buyer: BuyerCode;
    days: number;
    lines: PfLine[];
    status: string;
    sentDays?: number;
    decidedDays?: number;
    rejectReason?: string;
    incoterms?: string;
    validDays?: number;
    charges?: ChargeDef[];
  }) {
    const b = buyers[opts.buyer];
    const domestic = b.market === 'DOMESTIC';
    const pf = await prisma.proforma.create({
      data: {
        number: domestic ? nextDpi() : nextPi(),
        buyerId: b.id,
        currencyId: b.currencyId,
        status: opts.status,
        date: ago(opts.days),
        validUntil: ago(opts.days - (opts.validDays ?? 30)),
        paymentTerms: domestic ? '50% advance, balance on delivery' : '30% advance against PI, balance against B/L copy',
        deliveryTerms: domestic ? '21 days from confirmation' : `${opts.lines.reduce((a, l) => a + l.qty, 0) > 60 ? '75' : '55'} days from advance receipt`,
        // Incoterms are an export concept; a domestic sale has delivery terms instead.
        incoterms: domestic ? null : opts.incoterms ?? 'FOB Mundra',
        bankDetails: 'Bank: State Bank of India, Sardarpura, Jodhpur\nA/C: 3812 4457 9910\nIFSC: SBIN0031234\nSWIFT: SBININBB245',
        notes: 'Prices valid 30 days. Packing: 7-ply export carton, 1 pc per carton. Photographs indicative of finish.',
        showImages: true,
        exchangeRate: b.rate,
        // The tax basis, frozen as the app freezes it — so a later address correction
        // cannot restate a document the buyer already holds.
        taxMarket: b.market,
        taxBuyerState: (buyerDefs.find((x) => x.code === opts.buyer) as DemoBuyer | undefined)?.state ?? null,
        taxCompanyState: ourStateSeed,
        sentAt: opts.sentDays != null ? ago(opts.sentDays) : null,
        decidedAt: opts.decidedDays != null ? ago(opts.decidedDays) : null,
        rejectReason: opts.rejectReason ?? null,
        createdById: admin.id,
        lines: {
          create: opts.lines.map((l, i) => {
            const def = PRODUCTS.find((p) => p.code === l.code)!;
            return {
              productId: productIds[l.code],
              description: `${def.name} — ${def.alias}`,
              qty: l.qty,
              // Domestic is quoted off Non-FOB: no CHA, no forwarder, no ICD.
              unitPrice: domestic ? domesticPrice(l.code) : priceIn(l.code, b.rate),
              discountPct: l.discountPct ?? 0,
              gstRatePct: domestic ? 18 : 0,
              hsnCode: domestic ? '9403' : null,
              sortOrder: i,
            };
          }),
        },
        charges: {
          create: (opts.charges ?? []).map((c, i) => ({
            name: c.name,
            kind: c.kind ?? 'CHARGE',
            amount: c.amount ?? 0,
            pct: c.pct ?? 0,
            gstRatePct: c.gstRatePct ?? 0,
            isTaxable: c.isTaxable ?? true,
            sortOrder: i,
          })),
        },
      },
      include: { lines: true, charges: true },
    });
    return pf;
  }

  async function makeOrder(
    pf: {
      id: number;
      buyerId: number;
      currencyId: number | null;
      exchangeRate: number | null;
      taxMarket?: string | null;
      taxBuyerState?: string | null;
      taxCompanyState?: string | null;
      lines: { productId: number | null; qty: number; unitPrice: number; discountPct?: number; gstRatePct?: number; hsnCode?: string | null }[];
      charges?: { name: string; kind: string; amount: number; pct: number; gstRatePct: number; isTaxable: boolean }[];
    },
    opts: { days: number; deliveryDays: number; status: string }
  ) {
    const domestic = Object.values(buyers).find((b) => b.id === pf.buyerId)?.market === 'DOMESTIC';
    const order = await prisma.order.create({
      data: {
        number: domestic ? nextDord() : nextOrd(),
        buyerId: pf.buyerId,
        currencyId: pf.currencyId,
        status: opts.status,
        orderDate: ago(opts.days),
        deliveryDate: ago(-opts.deliveryDays),
        incoterms: domestic ? null : 'FOB Mundra',
        exchangeRate: pf.exchangeRate,
        proformaId: pf.id,
        createdById: admin.id,
        taxMarket: pf.taxMarket ?? null,
        taxBuyerState: pf.taxBuyerState ?? null,
        taxCompanyState: pf.taxCompanyState ?? null,
        // Copied off the quote, exactly as accepting a PI does it.
        charges: {
          create: (pf.charges ?? []).map((c, i) => ({
            name: c.name, kind: c.kind, amount: c.amount, pct: c.pct, gstRatePct: c.gstRatePct, isTaxable: c.isTaxable, sortOrder: i,
          })),
        },
      },
    });
    for (let i = 0; i < pf.lines.length; i++) {
      const l = pf.lines[i];
      const product = await prisma.product.findUnique({ where: { id: l.productId! }, select: { stageLineId: true } });
      const line = await prisma.orderLine.create({
        data: {
          orderId: order.id, productId: l.productId!, qty: l.qty, unitPrice: l.unitPrice,
          discountPct: l.discountPct ?? 0, gstRatePct: l.gstRatePct ?? 0, hsnCode: l.hsnCode ?? null,
          sortOrder: i, stageLineId: product?.stageLineId ?? null,
        },
      });
      const steps = await prisma.stageLineStep.findMany({ where: { stageLineId: product!.stageLineId! }, orderBy: { sortOrder: 'asc' } });
      for (let s = 0; s < steps.length; s++) await prisma.orderLineStage.create({ data: { orderLineId: line.id, name: steps[s].name, sortOrder: s } });
    }
    return prisma.order.findUnique({ where: { id: order.id }, include: { lines: { include: { stages: { orderBy: { sortOrder: 'asc' } }, product: true }, orderBy: { sortOrder: 'asc' } } } });
  }

  /** Hand pieces from one stage to another, recording a hop per stage crossed. */
  async function move(lineId2: number, stages: { id: number; name: string; sortOrder: number }[], from: number | null, to: number | null, qty: number, days: number, note?: string) {
    const kind = from == null ? 'RELEASE' : to == null ? 'COMPLETE' : to > from ? 'ADVANCE' : 'REJECT';
    const created: number[] = [];
    if (kind === 'ADVANCE') {
      for (let s = from!; s < to!; s++) {
        const m = await prisma.stageMove.create({
          data: { orderLineId: lineId2, kind: 'ADVANCE', fromStageId: stages[s].id, toStageId: stages[s + 1].id, qty, date: ago(days), note: note ?? null, createdById: admin.id },
        });
        created.push(m.id);
      }
    } else {
      const m = await prisma.stageMove.create({
        data: {
          orderLineId: lineId2,
          kind,
          fromStageId: from == null ? null : stages[from].id,
          toStageId: to == null ? null : stages[to].id,
          qty,
          date: ago(days),
          note: note ?? null,
          createdById: admin.id,
        },
      });
      created.push(m.id);
    }
    return created;
  }

  const outsource = async (stageId: number, vendorCode: string, rate: number) => prisma.orderLineStage.update({ where: { id: stageId }, data: { vendorId: sup[vendorCode], jobworkRate: rate } });

  // 1. Ashford — shipped and fully paid.
  const pf1 = await makeProforma({ buyer: 'AB', days: 74, sentDays: 73, decidedDays: 70, status: 'Accepted', lines: [{ code: 'AB-2101', qty: 40 }, { code: 'AB-2102', qty: 30 }] });
  const ord1 = (await makeOrder(pf1, { days: 70, deliveryDays: -6, status: 'Shipped' }))!;
  for (const line of ord1.lines) {
    const st = line.stages;
    await outsource(st[1].id, 'JOB-POWDER', 130); // powder coating
    await move(line.id, st, null, 0, line.qty, 66, 'Full batch issued to the floor');
    await move(line.id, st, 0, st.length - 1, line.qty, 58, 'Coated, fitted and QC passed');
    await move(line.id, st, st.length - 1, null, line.qty, 52, 'Packed and loaded for Mundra');
  }

  // 2. Heritage — mid-production, tiles outsourced, a QC rejection in flight.
  const pf2 = await makeProforma({ buyer: 'HG', days: 58, sentDays: 57, decidedDays: 54, status: 'Accepted', lines: [{ code: 'HG-2201', qty: 60 }, { code: 'HG-2202', qty: 40 }, { code: 'HG-2601', qty: 50 }] });
  const ord2 = (await makeOrder(pf2, { days: 54, deliveryDays: 24, status: 'Production' }))!;
  const photoMoves: number[] = [];
  for (const line of ord2.lines) {
    const st = line.stages;
    const code = line.product.factoryCode;
    if (code.startsWith('HG-22')) {
      // Wood line: tiles set by an outside studio at stage 4, polish in-house.
      await outsource(st[3].id, 'JOB-TILE', 240);
      await move(line.id, st, null, 0, line.qty, 46, 'Carcasses cut and issued');
      await move(line.id, st, 0, 3, line.qty, 38, 'Sanded and polished in-house, ready for tiles');
      const done = Math.round(line.qty * 0.6);
      const ids = await move(line.id, st, 3, 4, done, 24, 'Tiles set and returned from Marigold — grout cured');
      photoMoves.push(ids[ids.length - 1]);
      // QC rejects a few for chipped tiles; they go back to the tile studio.
      const rejected = Math.max(2, Math.round(done * 0.1));
      await move(line.id, st, 4, 3, rejected, 16, 'QC: 2 tiles chipped on transit — returned to studio');
    } else {
      // Metal line: coating outsourced, then fitted here.
      await outsource(st[1].id, 'JOB-POWDER', 145);
      await move(line.id, st, null, 0, line.qty, 44, 'Carcasses cut and issued');
      await move(line.id, st, 0, 2, Math.round(line.qty * 0.8), 30, 'Legs coated matt black by Shakti');
      await move(line.id, st, 2, 3, Math.round(line.qty * 0.5), 18, 'Fitted, awaiting QC');
    }
  }

  // 3. Möbelwerk — carving outsourced, just under way.
  const pf3 = await makeProforma({ buyer: 'MW', days: 34, sentDays: 33, decidedDays: 30, status: 'Accepted', lines: [{ code: 'MW-2501', qty: 24 }, { code: 'MW-2301', qty: 18 }], incoterms: 'FOB Mundra' });
  const ord3 = (await makeOrder(pf3, { days: 30, deliveryDays: 52, status: 'Production' }))!;
  for (const line of ord3.lines) {
    const st = line.stages;
    if (line.product.factoryCode === 'MW-2501') {
      await outsource(st[2].id, 'JOB-CARVE', 620); // hand carving at the polishing slot
      await move(line.id, st, null, 0, line.qty, 22, 'Almirah carcasses issued');
      await move(line.id, st, 0, 2, line.qty, 14, 'Sanded, sent to Precision Carving');
      await move(line.id, st, 2, 3, 10, 5, 'First 10 carved mandalas back — excellent depth');
    } else {
      await outsource(st[2].id, 'JOB-POLISH', 210);
      await move(line.id, st, null, 0, line.qty, 20, 'Hutch panels issued');
      await move(line.id, st, 0, 1, line.qty, 11, 'Raw sanding complete');
    }
  }

  // 4. Ashford — confirmed last week, nothing on the floor yet.
  const pf4 = await makeProforma({ buyer: 'AB', days: 16, sentDays: 15, decidedDays: 11, status: 'Accepted', lines: [{ code: 'AB-2401', qty: 26 }, { code: 'AB-2801', qty: 34 }] });
  const ord4 = (await makeOrder(pf4, { days: 11, deliveryDays: 68, status: 'Confirmed' }))!;
  for (const line of ord4.lines) {
    await outsource(line.stages[1].id, 'JOB-POWDER', 150);
  }

  // Open proformas: one awaiting a reply, one rejected, one still a draft.
  const pf5 = await makeProforma({ buyer: 'MW', days: 9, sentDays: 8, status: 'Sent', lines: [{ code: 'MW-2701', qty: 22 }, { code: 'MW-2301', qty: 14 }] });
  const pf6 = await makeProforma({ buyer: 'HG', days: 21, sentDays: 20, decidedDays: 13, status: 'Rejected', rejectReason: 'Landed cost above their retail ladder — asked us to re-quote at 500+ pcs', lines: [{ code: 'HG-2601', qty: 120 }] });
  const pf7 = await makeProforma({ buyer: 'AB', days: 2, status: 'Draft', lines: [{ code: 'AB-2101', qty: 60 }, { code: 'AB-2401', qty: 20 }, { code: 'AB-2801', qty: 40 }] });

  // --- domestic: rupees, GST, and charges on the document -------------------
  //
  // Three shapes worth seeing side by side. Jodhpur Furnishings is in our own state, so
  // the tax splits CGST + SGST; Urban Decor is in Maharashtra, so the identical money
  // becomes IGST; the walk-in is B2C with no GSTIN at all. All three carry freight and a
  // discount at document level, which is what the buyer asked for.
  const pf8 = await makeProforma({
    buyer: 'JF', days: 26, sentDays: 25, decidedDays: 22, status: 'Accepted',
    lines: [{ code: 'MW-2701', qty: 12 }, { code: 'AB-2102', qty: 8, discountPct: 5 }],
    charges: [
      { name: 'Freight to Sardarpura', amount: 4500, gstRatePct: 18 },
      { name: 'Dealer discount', kind: 'DISCOUNT', pct: 4, gstRatePct: 18 },
    ],
  });
  const dord1 = (await makeOrder(pf8, { days: 22, deliveryDays: 9, status: 'Production' }))!;
  for (const line of dord1.lines) {
    const st = line.stages;
    await move(line.id, st, null, 0, line.qty, 20, 'Domestic batch released');
    await move(line.id, st, 0, 2, Math.round(line.qty * 0.6), 12, 'Through joining and sanding');
  }

  const pf9 = await makeProforma({
    buyer: 'UD', days: 15, sentDays: 14, decidedDays: 11, status: 'Accepted',
    lines: [{ code: 'HG-2601', qty: 18 }],
    charges: [
      { name: 'Transport to Mumbai', amount: 16500, gstRatePct: 18 },
      { name: 'Packing', amount: 3200, gstRatePct: 18 },
    ],
  });
  const dord2 = (await makeOrder(pf9, { days: 11, deliveryDays: 18, status: 'Confirmed' }))!;

  // Retail, still a live quote: one piece, a flat discount, delivery charged.
  const pf10 = await makeProforma({
    buyer: 'WLK', days: 4, sentDays: 3, status: 'Sent',
    lines: [{ code: 'MW-2501', qty: 1 }],
    charges: [
      { name: 'Home delivery', amount: 900, gstRatePct: 18 },
      { name: 'Festive discount', kind: 'DISCOUNT', amount: 2000, gstRatePct: 18 },
    ],
  });
  console.log(`  10 proformas (3 open, 1 rejected, 6 accepted), 6 orders`);
  console.log(`    domestic: ${pf8.number} -> ${dord1.number} (CGST+SGST), ${pf9.number} -> ${dord2.number} (IGST), ${pf10.number} open (B2C)`);

  // --- hand-over photos ---------------------------------------------------
  let photoCount = 0;
  const proofShots = ['jaipur-tiled-sideboard.jpg', 'jaipur-tiled-tall-cabinet.jpg'];
  for (let i = 0; i < photoMoves.length && i < proofShots.length; i++) {
    const filename = `move-demo-${i + 1}-${proofShots[i]}`;
    fs.copyFileSync(path.join(ASSETS, proofShots[i]), path.join(UPLOADS, filename));
    await prisma.stageMovePhoto.create({ data: { moveId: photoMoves[i], filename, originalName: proofShots[i], url: `/uploads/${filename}`, caption: 'Tile work as received', sortOrder: 0 } });
    photoCount++;
  }

  // --- material sheets ----------------------------------------------------
  let opNo = 0;
  for (const order of [ord2, ord3]) {
    for (const line of order.lines.slice(0, 2)) {
      await prisma.operationSheet.create({
        data: { number: `OP-${String(++opNo).padStart(4, '0')}`, productId: line.productId, orderId: order.id, orderLineId: line.id, qty: line.qty, createdById: admin.id, createdAt: ago(40) },
      });
    }
  }

  // --- money --------------------------------------------------------------
  // Through the one pricing engine, so a domestic order's value includes its charges
  // and its GST. Summing qty x price here would make every receipt below the wrong size.
  const ourState = (await prisma.company.findUnique({ where: { id: 1 } }))?.state ?? null;
  const value = async (orderId: number) => {
    const o = await prisma.order.findUnique({
      where: { id: orderId },
      include: { lines: true, charges: true, buyer: { select: { market: true, state: true } } },
    });
    return round(documentValueOf(o as never, ourState));
  };
  const v1 = await value(ord1.id);
  const v2 = await value(ord2.id);
  const v3 = await value(ord3.id);
  const v4 = await value(ord4.id);
  const d1 = await value(dord1.id);
  const d2 = await value(dord2.id);

  const CCY: Record<string, string> = { AB: 'GBP', HG: 'USD', MW: 'EUR', JF: 'INR', UD: 'INR', WLK: 'INR' };
  const receipt = (buyerCode: BuyerCode, orderId: number | null, amount: number, days: number, ref: string) =>
    prisma.ledgerEntry.create({
      data: {
        partyType: 'BUYER',
        buyerId: buyers[buyerCode].id,
        orderId,
        partyName: buyers[buyerCode].name,
        kind: 'PAYMENT',
        amount: round(amount),
        currency: CCY[buyerCode] ?? 'INR',
        date: ago(days),
        ref,
        createdById: admin.id,
      },
    });

  // Ashford: order 1 settled, then a large transfer that clears the rest of
  // order 1 and rolls straight on to order 4 — FIFO doing the work.
  await receipt('AB', ord1.id, round(v1 * 0.3), 68, 'SWIFT 30% advance');
  await receipt('AB', ord1.id, round(v1 * 0.7 + v4 * 0.3), 44, 'SWIFT balance + next advance');
  // Heritage: 30% advance only.
  await receipt('HG', ord2.id, round(v2 * 0.3), 52, 'SWIFT 30% advance');
  // Möbelwerk: paid more than the order needs — the surplus waits on account.
  await receipt('MW', ord3.id, round(v3 * 1.1), 28, 'SEPA advance (over-remitted)');
  // Domestic: the dealer paid half of the GST-inclusive total, the Mumbai order is
  // wholly unpaid so the receivable shows the tax as well as the goods.
  await receipt('JF', dord1.id, round(d1 * 0.5), 20, 'NEFT 50% advance');
  // The Mumbai order is left wholly unpaid on purpose, so the receivable there shows
  // the tax as well as the goods.

  // Jobwork: part-pay the polishers, leave the coaters running.
  await prisma.ledgerEntry.create({
    data: { partyType: 'JOBWORK', supplierId: sup['JOB-TILE'], orderId: ord2.id, partyName: 'Marigold Tile Studio', kind: 'PAYMENT', amount: 6000, currency: 'INR', date: ago(20), ref: 'NEFT part payment', createdById: admin.id },
  });
  await prisma.ledgerEntry.create({
    data: { partyType: 'JOBWORK', supplierId: sup['JOB-POWDER'], orderId: ord1.id, partyName: 'Shakti Powder Coating', kind: 'PAYMENT', amount: 9100, currency: 'INR', date: ago(50), ref: 'NEFT against ORD-0001', createdById: admin.id },
  });

  // Material: two deliveries billed, the rest still to be billed.
  const billFor = async (key: string, supplierCode: string, amount: number, days: number, ref: string, note: string) => {
    const id = stockIds[key];
    if (!id) return;
    await prisma.ledgerEntry.create({
      data: { partyType: 'SUPPLIER', supplierId: sup[supplierCode], stockTxnId: id, partyName: supplierDefs.find((s) => s.code === supplierCode)!.name, kind: 'BILL', amount: round(amount), currency: 'INR', date: ago(days), ref, note, createdById: admin.id },
    });
  };
  await billFor('RM-MANGO-47', 'SUP-TIMBER', 120 * 612, 46, 'STT/24-25/881', 'Seasoned mango, 22 logs');
  await billFor('RM-IRON-30', 'SUP-METAL', 240 * 92, 29, 'MCW/1194', '25x25 MS square section');
  await prisma.ledgerEntry.create({
    data: { partyType: 'SUPPLIER', supplierId: sup['SUP-TIMBER'], partyName: 'Sharma Timber Traders', kind: 'PAYMENT', amount: 50000, currency: 'INR', date: ago(30), ref: 'RTGS part payment', createdById: admin.id },
  });
  // --- the workforce ------------------------------------------------------
  //
  // Wages are DERIVED here, exactly as they are in the running app: nothing is billed.
  // Attendance is exceptions-only, so these workers earn for every working day since
  // they joined unless a row below says otherwise, and the piece workers earn from the
  // clearances they are named on.
  await seedWorkforce(admin.id);

  // --- the sales side: packed cartons, containers, dispatch, invoices -------
  //
  // Chosen so each rule is visible in the demo rather than only in the self-checks:
  // an order shipped in TWO PARTS (so the derived status is seen to stay Ready and then
  // flip to Shipped), a shipment drawing on TWO ORDERS, a domestic tax invoice with an
  // e-way bill, and free-pool stock that belongs to no order at all.
  const { shipments: shipCount, invoices: invCount, shpNo, invNo, dinvNo } = await seedSales(admin.id);

  // Document counters continue from what the demo used.
  await prisma.docSequence.update({ where: { key: 'PI' }, data: { lastNo: piNo } });
  await prisma.docSequence.update({ where: { key: 'ORD' }, data: { lastNo: ordNo } });
  await prisma.docSequence.update({ where: { key: 'DPI' }, data: { lastNo: dpiNo } });
  await prisma.docSequence.update({ where: { key: 'DORD' }, data: { lastNo: dordNo } });
  await prisma.docSequence.update({ where: { key: 'OP' }, data: { lastNo: opNo } });
  await prisma.docSequence.update({ where: { key: 'SHP' }, data: { lastNo: shpNo } });
  await prisma.docSequence.update({ where: { key: 'INV' }, data: { lastNo: invNo } });
  await prisma.docSequence.update({ where: { key: 'DINV' }, data: { lastNo: dinvNo } });

  console.log(`  ${photoCount} hand-over photos, ${opNo} material sheets`);
  console.log(`  ${shipCount} shipments, ${invCount} invoices`);
  console.log('\nOrder values:');
  console.log(`  ${dord1.number}  INR ${d1.toLocaleString('en-IN')}  (domestic, CGST+SGST)`);
  console.log(`  ${dord2.number}  INR ${d2.toLocaleString('en-IN')}  (domestic, IGST)`);
  for (const [n, v, c] of [
    [ord1.number, v1, 'GBP'],
    [ord2.number, v2, 'USD'],
    [ord3.number, v3, 'EUR'],
    [ord4.number, v4, 'GBP'],
  ] as [string, number, string][]) {
    console.log(`  ${n}  ${c} ${v.toLocaleString('en-IN')}`);
  }
  console.log('\nDemo ready.  admin@saraswati.local / admin123');
}

/**
 * Finished stock, packing, dispatch and invoicing.
 *
 * Everything here is written as the routes would write it: cartons come from
 * `piecesPerCarton`, the packing batch SNAPSHOTS the product's dims and weights, and no
 * total is stored on an invoice — its money is derived by `documentTotalsOf()` on read.
 *
 * The order statuses are left to `syncOrderStatus`, which is what proves the derived rule
 * rather than asserting it: the part-shipped order really does read Ready.
 */
async function seedSales(userId: number) {
  const day = (back: number) => {
    const d = new Date();
    d.setDate(d.getDate() - back);
    d.setHours(9, 0, 0, 0);
    return d;
  };

  /** Every finished, unpacked line of an order, ready to box. */
  const linesOf = async (orderNumber: string) => {
    const order = await prisma.order.findFirst({
      where: { number: orderNumber },
      include: { lines: { include: { stages: true, moves: true, product: true } }, buyer: true, currency: true },
    });
    if (!order) return null;
    return order;
  };

  const packLine = async (
    line: { id: number; productId: number; product: { piecesPerCarton: number | null; packLengthIn: number | null; packWidthIn: number | null; packHeightIn: number | null; netWeightKg: number | null; grossWeightKg: number | null; volumeAfterPackingCbm: number | null } },
    qty: number,
    marks: string,
    packedOn: Date
  ) => {
    const per = line.product.piecesPerCarton && line.product.piecesPerCarton > 0 ? line.product.piecesPerCarton : 1;
    const cartons = Math.ceil(qty / per);
    return prisma.packingBatch.create({
      data: {
        productId: line.productId,
        orderLineId: line.id,
        qty,
        cartonCount: cartons,
        // Snapshotted, so correcting the product master later cannot change a packing list
        // that has already been printed.
        piecesPerCarton: per,
        packLengthIn: line.product.packLengthIn,
        packWidthIn: line.product.packWidthIn,
        packHeightIn: line.product.packHeightIn,
        netWeightKg: line.product.netWeightKg,
        grossWeightKg: line.product.grossWeightKg,
        cbmPerPiece: line.product.volumeAfterPackingCbm,
        shippingMarks: marks,
        packedOn,
        createdById: userId,
      },
    });
  };

  let shpNo = 0;
  let invNo = 0;
  let dinvNo = 0;
  let shipments = 0;
  let invoices = 0;

  const twenty = await prisma.containerType.findUnique({ where: { code: '20FT' } });
  const fortyHQ = await prisma.containerType.findUnique({ where: { code: '40HQ' } });

  // --- 1. an export order shipped in TWO PARTS ------------------------------
  const ord1 = await linesOf('ORD-2026-0001');
  if (ord1 && fortyHQ) {
    const ready = ord1.lines.filter((l) => buildBoard(l.qty, l.stages as never, l.moves as never).done > 0);
    if (ready.length >= 2) {
      const [a, b] = ready;
      const boardA = buildBoard(a.qty, a.stages as never, a.moves as never);
      // First half: part of line A only, so the order is visibly NOT fully shipped.
      const half = Math.max(1, Math.floor(boardA.done / 2));
      const batchA1 = await packLine(a, half, `SE/${ord1.number}/1-UP`, day(24));
      shpNo += 1;
      const ship1 = await prisma.shipment.create({
        data: {
          number: `SHP-${String(shpNo).padStart(4, '0')}`,
          status: 'SHIPPED',
          shipDate: day(21),
          shippingBillNo: `SB/${7100 + shpNo}/26`,
          portOfLoading: 'Mundra',
          portOfDischarge: 'Felixstowe',
          finalDestination: 'London, UK',
          vesselOrFlight: 'MV Ganges Star / 214W',
          blAwbNo: `MSCU${480000 + shpNo}`,
          createdById: userId,
        },
      });
      const c1 = await prisma.shipmentContainer.create({
        data: { shipmentId: ship1.id, containerTypeId: fortyHQ.id, containerNo: `MSCU${1230000 + shpNo}`, sealNo: `SL${9900 + shpNo}`, tareWeightKg: 3900 },
      });
      await prisma.shipmentLine.create({ data: { shipmentId: ship1.id, packingBatchId: batchA1.id, containerId: c1.id, cartons: batchA1.cartonCount, qty: batchA1.qty } });
      shipments += 1;

      // The rest of line A — a SECOND part shipment. Line B is deliberately left behind, so
      // the order is visibly still `Ready` after both of these: 40 of its 70 pieces have
      // gone. That is the derived-status rule on show rather than asserted.
      const batchA2 = await packLine(a, boardA.done - half, `SE/${ord1.number}/2-UP`, day(12));
      shpNo += 1;
      const ship2 = await prisma.shipment.create({
        data: {
          number: `SHP-${String(shpNo).padStart(4, '0')}`,
          status: 'SHIPPED',
          shipDate: day(9),
          shippingBillNo: `SB/${7100 + shpNo}/26`,
          portOfLoading: 'Mundra',
          portOfDischarge: 'Felixstowe',
          finalDestination: 'London, UK',
          vesselOrFlight: 'MV Thar Breeze / 118W',
          blAwbNo: `MSCU${480000 + shpNo}`,
          createdById: userId,
        },
      });
      const c2 = await prisma.shipmentContainer.create({
        data: { shipmentId: ship2.id, containerTypeId: fortyHQ.id, containerNo: `MSCU${1230000 + shpNo}`, sealNo: `SL${9900 + shpNo}`, tareWeightKg: 3900 },
      });
      await prisma.shipmentLine.create({ data: { shipmentId: ship2.id, packingBatchId: batchA2.id, containerId: c2.id, cartons: batchA2.cartonCount, qty: batchA2.qty } });
      shipments += 1;

      // A commercial invoice for the second dispatch, with CIF charges and a part receipt.
      invNo += 1;
      const inv = await prisma.invoice.create({
        data: {
          number: `INV-2026-${String(invNo).padStart(4, '0')}`,
          status: 'ISSUED',
          buyerId: ord1.buyerId,
          currencyId: ord1.currencyId,
          exchangeRate: ord1.exchangeRate,
          invoiceDate: day(8),
          shipmentId: ship2.id,
          incoterms: 'CIF',
          taxMarket: 'OVERSEAS',
          taxBuyerState: ord1.buyer.state,
          taxCompanyState: 'Rajasthan',
          paymentTerms: '30 days from BL date',
          bankDetails: 'HDFC Bank, Jodhpur · A/c 50200012345678 · SWIFT HDFCINBB',
          createdById: userId,
        },
      });
      let sort = 0;
      for (const [bt, ol] of [[batchA2, a]] as const) {
        await prisma.invoiceLine.create({
          data: {
            invoiceId: inv.id,
            productId: ol.productId,
            // Named so a receipt against this invoice can be attributed back to the order.
            orderLineId: ol.id,
            qty: bt.qty,
            // COPIES of the order's price inputs — the document is frozen against a later
            // correction, yet no figure on it can contradict the pricing engine.
            unitPrice: ol.unitPrice,
            discountPct: ol.discountPct,
            discountAmt: ol.discountAmt,
            gstRatePct: 0,
            hsnCode: ol.hsnCode,
            sortOrder: sort++,
          },
        });
      }
      // Freight and insurance are what turn FOB into CIF, and they belong to the document.
      await prisma.invoiceCharge.create({ data: { invoiceId: inv.id, name: 'Ocean freight', kind: 'CHARGE', amount: 520, gstRatePct: 0, sortOrder: 0 } });
      await prisma.invoiceCharge.create({ data: { invoiceId: inv.id, name: 'Marine insurance', kind: 'CHARGE', pct: 1.1, gstRatePct: 0, sortOrder: 1 } });
      invoices += 1;

      await syncSalesStatus(ord1.id);
    }
  }

  // --- 2. one shipment drawing on TWO ORDERS of the SAME buyer -------------
  //
  // ORD-2026-0004 belongs to the same buyer as ORD-2026-0001, so the two really can be
  // co-loaded. Its board is still mid-production, so the pieces come from an OPENING
  // adjustment — which is exactly what that reason is for: stock that was finished before
  // the system started keeping the board.
  const ord4 = await linesOf('ORD-2026-0004');
  if (ord1 && ord4 && twenty && ord4.buyerId === ord1.buyerId) {
    const l4 = ord4.lines[0];
    const opening = Math.min(12, l4.qty);
    await prisma.finishedTxn.create({
      data: { productId: l4.productId, kind: 'ADJUST_IN', qty: opening, orderLineId: l4.id, reason: 'OPENING', note: 'Finished before go-live', date: day(20), createdById: userId },
    });
    const bt4 = await packLine(l4, opening, `SE/${ord4.number}/CO`, day(4));

    // …and the line the first order still had outstanding goes in the SAME box. That is what
    // makes this a consolidated container rather than two shipments — and shipping it is what
    // finally takes ORD-2026-0001 to `Shipped`.
    const l1 = ord1.lines[1] ?? ord1.lines[0];
    const board1 = buildBoard(l1.qty, l1.stages as never, l1.moves as never);
    const bt1 = await packLine(l1, board1.done, `SE/${ord1.number}/CO`, day(4));

    shpNo += 1;
    const ship = await prisma.shipment.create({
      data: {
        number: `SHP-${String(shpNo).padStart(4, '0')}`,
        status: 'LOADED',
        shipDate: null,
        portOfLoading: 'Mundra',
        portOfDischarge: 'Felixstowe',
        createdById: userId,
        notes: 'Two orders for one buyer, consolidated into a single box.',
      },
    });
    const c = await prisma.shipmentContainer.create({ data: { shipmentId: ship.id, containerTypeId: twenty.id, tareWeightKg: 2200 } });
    for (const bt of [bt4, bt1]) {
      await prisma.shipmentLine.create({ data: { shipmentId: ship.id, packingBatchId: bt.id, containerId: c.id, cartons: bt.cartonCount, qty: bt.qty } });
    }
    shipments += 1;
    for (const o of [ord1, ord4]) await syncSalesStatus(o.id);
  }

  // --- 3. a domestic dispatch with a GST tax invoice and an e-way bill ------
  const dord = await linesOf('DORD-2026-0001');
  if (dord && twenty) {
    const l = dord.lines[0];
    if (l) {
      // Same reason as above: this order is mid-production, so its shippable pieces are an
      // opening balance rather than board completions.
      const opening = Math.min(8, l.qty);
      await prisma.finishedTxn.create({
        data: { productId: l.productId, kind: 'ADJUST_IN', qty: opening, orderLineId: l.id, reason: 'OPENING', note: 'Finished before go-live', date: day(14), createdById: userId },
      });
      const bt = await packLine(l, opening, `SE/${dord.number}`, day(6));
      shpNo += 1;
      const ship = await prisma.shipment.create({
        data: {
          number: `SHP-${String(shpNo).padStart(4, '0')}`,
          status: 'DELIVERED',
          shipDate: day(5),
          // Domestic movement paperwork — all optional, and typed in.
          transporterName: 'Rajdhani Roadways',
          transporterGstin: '08AAACR1234M1ZP',
          vehicleNo: 'RJ 19 GA 4471',
          ewayBillNo: '381004512789',
          ewayBillDate: day(5),
          createdById: userId,
        },
      });
      const c = await prisma.shipmentContainer.create({ data: { shipmentId: ship.id, containerTypeId: twenty.id, tareWeightKg: 2200 } });
      await prisma.shipmentLine.create({ data: { shipmentId: ship.id, packingBatchId: bt.id, containerId: c.id, cartons: bt.cartonCount, qty: bt.qty } });
      shipments += 1;

      dinvNo += 1;
      const inv = await prisma.invoice.create({
        data: {
          number: `DINV-2026-${String(dinvNo).padStart(4, '0')}`,
          status: 'ISSUED',
          buyerId: dord.buyerId,
          currencyId: dord.currencyId,
          exchangeRate: dord.exchangeRate ?? 1,
          invoiceDate: day(5),
          shipmentId: ship.id,
          taxMarket: 'DOMESTIC',
          taxBuyerState: dord.buyer.state,
          taxCompanyState: 'Rajasthan',
          placeOfSupply: dord.buyer.state,
          paymentTerms: '15 days',
          createdById: userId,
        },
      });
      await prisma.invoiceLine.create({
        data: {
          invoiceId: inv.id,
          productId: l.productId,
          orderLineId: l.id,
          qty: bt.qty,
          unitPrice: l.unitPrice,
          discountPct: l.discountPct,
          discountAmt: l.discountAmt,
          // A domestic line is taxed; the rate is copied like every other price input.
          gstRatePct: l.gstRatePct || 18,
          hsnCode: l.hsnCode,
          sortOrder: 0,
        },
      });
      invoices += 1;
      await syncSalesStatus(dord.id);
    }
  }

  // --- 4. free-pool stock: belongs to no order, any order may draw on it ----
  const spare = await prisma.product.findFirst({ where: { deletedAt: null }, orderBy: { id: 'asc' } });
  if (spare) {
    for (const t of [
      { kind: 'ADJUST_IN', qty: 12, reason: 'OPENING', note: 'Opening balance at go-live', date: day(60) },
      { kind: 'ADJUST_OUT', qty: 2, reason: 'DAMAGE', note: 'Water damage in the godown', date: day(30) },
      { kind: 'RETURN_IN', qty: 1, reason: 'RETURN', note: 'Buyer returned one piece, polish defect', date: day(7) },
    ] as const) {
      await prisma.finishedTxn.create({ data: { productId: spare.id, kind: t.kind, qty: t.qty, orderLineId: null, reason: t.reason, note: t.note, date: t.date, createdById: userId } });
    }
  }

  return { shipments, invoices, shpNo, invNo, dinvNo };
}

/** Let the engine decide the order's status, exactly as a route would. */
async function syncSalesStatus(orderId: number) {
  const rows = await prisma.shipmentLine.findMany({
    where: { shipment: { deletedAt: null, status: { not: 'CANCELLED' } }, packingBatch: { orderLine: { orderId } } },
    select: { qty: true },
  });
  const shipped = rows.reduce((a, r) => a + r.qty, 0);
  await syncOrderStatus(prisma, orderId, shipped);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
