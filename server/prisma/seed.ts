import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { BUILTIN_METHODS } from '../src/lib/costing';
import { BUILTIN_CONTAINER_TYPES } from '../src/lib/shipping';
import { migrateTypedWorkers, seedManforceDefaults } from './manforceSeed';
import { ensureCompany } from '../src/lib/company';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding Saraswati ERP...');

  // --- Users ---------------------------------------------------------------
  const passwordHash = await bcrypt.hash('admin123', 10);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@saraswati.local' },
    update: {},
    create: { name: 'Administrator', email: 'admin@saraswati.local', role: 'Admin', passwordHash },
  });
  await prisma.user.upsert({
    where: { email: 'manager@saraswati.local' },
    update: {},
    create: { name: 'Production Manager', email: 'manager@saraswati.local', role: 'Manager', passwordHash: await bcrypt.hash('manager123', 10) },
  });

  // --- Currencies ----------------------------------------------------------
  const currencies = [
    { code: 'INR', name: 'Indian Rupee', symbol: '₹', rateToBase: 1, isBase: true },
    { code: 'USD', name: 'US Dollar', symbol: '$', rateToBase: 83, isBase: false },
    { code: 'EUR', name: 'Euro', symbol: '€', rateToBase: 90, isBase: false },
  ];
  for (const c of currencies) {
    await prisma.currency.upsert({ where: { code: c.code }, update: { name: c.name, symbol: c.symbol, rateToBase: c.rateToBase, isBase: c.isBase }, create: c });
  }
  const inr = await prisma.currency.findUnique({ where: { code: 'INR' } });

  // --- Cost methods (formulas) --------------------------------------------
  for (const m of BUILTIN_METHODS) {
    await prisma.costMethod.upsert({
      where: { code: m.code },
      update: { ...m, isBuiltIn: true },
      create: { ...m, isBuiltIn: true },
    });
  }

  // --- Units ---------------------------------------------------------------
  const units = [
    ['PCS', 'Pieces'], ['SET', 'Set'], ['KGS', 'Kilograms'], ['CFT', 'Cubic Feet'],
    ['SQFT', 'Square Feet'], ['SQM', 'Square Metre'], ['MTR', 'Metre'], ['LTR', 'Litre'], ['LOT', 'Lot'],
  ];
  for (let i = 0; i < units.length; i++) {
    const [code, name] = units[i];
    await prisma.unit.upsert({ where: { code }, update: { name, sortOrder: i }, create: { code, name, sortOrder: i } });
  }

  // --- Attribute master lists ---------------------------------------------
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
      const value = values[i];
      const rec = await prisma.attributeValue.upsert({
        where: { type_value: { type, value } },
        update: { sortOrder: i },
        create: { type, value, sortOrder: i },
      });
      attrId[type][value] = rec.id;
    }
  }

  // --- Buyers --------------------------------------------------------------
  // Every existing buyer is an overseas trade buyer — that is all the app supported
  // before — so the defaults are explicit rather than relying on the column default.
  const buyerDefs = [
    { code: 'AB', name: 'Ashford & Barnes Ltd.', country: 'United Kingdom', contactName: 'James Ashford', email: 'buying@ashfordbarnes.co.uk', market: 'OVERSEAS', channel: 'B2B' },
    { code: 'HG', name: 'Heritage Home Goods', country: 'USA', contactName: 'Laura Chen', email: 'purchasing@heritagehome.com', market: 'OVERSEAS', channel: 'B2B' },
    // A domestic trade buyer in our own state (CGST + SGST) and one outside it (IGST).
    { code: 'JF', name: 'Jodhpur Furnishings', country: 'India', contactName: 'Mahendra Singh', email: 'orders@jodhpurfurnishings.in', market: 'DOMESTIC', channel: 'B2B', state: 'Rajasthan', gstNo: '08AAFCJ4567K1Z9' },
    { code: 'UD', name: 'Urban Decor Mumbai', country: 'India', contactName: 'Priya Nair', email: 'buying@urbandecor.in', market: 'DOMESTIC', channel: 'B2B', state: 'Maharashtra', gstNo: '27AAGCU7788L1ZB' },
    // A walk-in retail customer: domestic B2C, no GSTIN.
    { code: 'WLK', name: 'Walk-in Customer', country: 'India', market: 'DOMESTIC', channel: 'B2C', state: 'Rajasthan' },
  ];
  const buyerId: Record<string, number> = {};
  for (const b of buyerDefs) {
    const rec = await prisma.buyer.upsert({ where: { code: b.code }, update: b, create: b });
    buyerId[b.code] = rec.id;
  }

  // --- Example product: CRAZY ALMIRAH (matches example.xlsx) ---------------
  // Left alone once it exists, so re-running the seed never wipes work that
  // orders, proformas or material sheets already point at.
  const demoExists = await prisma.product.findUnique({ where: { factoryCode: 'AB-00123' }, select: { id: true } });

  const L = (
    name: string,
    opts: Partial<{ qty: number; wastagePct: number; actualL: number; actualW: number; actualH: number; costL: number; costW: number; costH: number; actualWeight: number; unit: string; rate: number }>
  ) => ({ name, qty: 1, wastagePct: 0, ...opts });

  if (demoExists) console.log('  AB-00123 already present — left untouched.');
  else await prisma.product.create({
    data: {
      factoryCode: 'AB-00123',
      name: 'Crazy Almirah',
      alias: 'Crazy Almirah 2-Door',
      status: 'Active',
      description: 'Two-door mango & oak wood almirah with iron legs, glass door panel and powder-coated fittings.',
      productTypeId: attrId.PRODUCT_TYPE['Almirah'],
      itemTypeId: attrId.ITEM_TYPE['Knock-Down (KD)'],
      sizeId: attrId.SIZE['Large'],
      colourId: attrId.COLOUR['Distressed White'],
      materialId: attrId.MATERIAL['Mango Wood'],
      finishId: attrId.FINISH['Distressed'],
      unitId: (await prisma.unit.findUnique({ where: { code: 'PCS' } }))!.id,
      prodLengthIn: 36, prodWidthIn: 20, prodHeightIn: 72,
      netWeightKg: 58, grossWeightKg: 66,
      packLengthIn: 40, packWidthIn: 24, packHeightIn: 76, piecesPerCarton: 1,
      volumeBeforePackingCbm: 0.68, volumeAfterPackingCbm: 0.96,
      createdById: admin.id,
      buyers: { create: [{ buyerId: buyerId['AB'], buyerCode: 'AB-00123' }] },
      costSheets: {
        create: [
          {
            version: 1,
            isActive: true,
            currencyId: inr!.id,
            factoryExpensePct: 15,
            marginPct: 15,
            groups: {
              create: [
                {
                  head: 'MAIN_COMPONENT', name: 'Mango Wood', method: 'CFT', dimUnit: 'IN', sortOrder: 0,
                  lines: {
                    create: [
                      L('TOP', { actualL: 25, actualW: 32, actualH: 1, costL: 27, costW: 38.4, costH: 1, qty: 1, wastagePct: 20, rate: 560, unit: 'CFT' }),
                      L('SIDE', { actualL: 59, actualW: 15, actualH: 1, costL: 63, costW: 18, costH: 1, qty: 2, wastagePct: 20, rate: 760, unit: 'CFT' }),
                      L('PARTITION', { actualL: 56, actualW: 16, actualH: 1, costL: 60, costW: 19.2, costH: 1, qty: 1, wastagePct: 20, rate: 760, unit: 'CFT' }),
                      L('SHELF', { actualL: 14, actualW: 17, actualH: 1, costL: 18, costW: 20.4, costH: 1, qty: 4, wastagePct: 20, rate: 560, unit: 'CFT' }),
                      L('BOTTOM', { actualL: 24, actualW: 16, actualH: 1, costL: 27, costW: 19.2, costH: 1, qty: 1, wastagePct: 20, rate: 560, unit: 'CFT' }),
                      L('DOOR FRAME', { actualL: 56, actualW: 13, actualH: 1.5, costL: 60, costW: 15.6, costH: 1.5, qty: 1, wastagePct: 20, rate: 760, unit: 'CFT' }),
                    ],
                  },
                },
                {
                  head: 'MAIN_COMPONENT', name: 'Oak Wood', method: 'SQFT', dimUnit: 'IN', sortOrder: 1,
                  lines: { create: [L('DOOR PANEL', { actualL: 34, actualW: 16, costL: 36, costW: 19.2, qty: 1, wastagePct: 20, rate: 490, unit: 'SQFT' })] },
                },
                {
                  head: 'SUB_COMPONENT', name: 'Iron — Powdercoated Fitting', method: 'WEIGHT', sortOrder: 0,
                  lines: { create: [L('PWDRFTG/133', { actualWeight: 14.38, wastagePct: 4.31, qty: 1, rate: 182, unit: 'KGS' })] },
                },
                {
                  head: 'SUB_COMPONENT', name: 'Iron — Powdercoated Legs', method: 'QTY', sortOrder: 1,
                  lines: { create: [L('PWDRCTDLGS/1452', { qty: 1, rate: 1200, unit: 'PCS' })] },
                },
                {
                  head: 'SUB_COMPONENT', name: 'Ply 6mm', method: 'SQFT', dimUnit: 'IN', sortOrder: 2,
                  lines: {
                    create: [
                      L('BACK PLY', { actualL: 18, actualW: 32, costL: 18, costW: 32, qty: 2, rate: 30, unit: 'SQFT' }),
                      L('BOTTOM PLY', { actualL: 19, actualW: 12, costL: 19, costW: 12, qty: 5, rate: 30, unit: 'SQFT' }),
                    ],
                  },
                },
                {
                  head: 'SUB_COMPONENT', name: 'Ply 8mm', method: 'SQMT', dimUnit: 'CM', sortOrder: 3,
                  lines: { create: [L('BOTTOM SUPPORT', { actualL: 42, actualW: 30, costL: 42, costW: 30, qty: 1, rate: 960, unit: 'SQM' })] },
                },
                {
                  head: 'SUB_COMPONENT', name: 'Glass 4mm', method: 'SQFT', dimUnit: 'IN', sortOrder: 4,
                  lines: { create: [L('DOOR GLASS', { actualL: 12, actualW: 18, costL: 12, costW: 18, qty: 1, rate: 130, unit: 'SQFT' })] },
                },
                {
                  head: 'HARDWARE', name: 'Hardware', method: 'QTY', sortOrder: 0,
                  lines: {
                    create: [
                      L("11' HANDLE", { qty: 2, rate: 63, unit: 'PCS' }),
                      L("1.5' SCREW", { qty: 30, rate: 0.82, unit: 'PCS' }),
                      L('F35 NAILS', { qty: 2, rate: 50, unit: 'SET' }),
                      L("2' BRASS KNOB", { qty: 1, rate: 112, unit: 'PCS' }),
                      L('60N PAPER', { qty: 3, rate: 58, unit: 'PCS' }),
                      L('120N PAPER', { qty: 3, rate: 39, unit: 'PCS' }),
                      L("10' CHAIN", { qty: 1, rate: 12, unit: 'PCS' }),
                    ],
                  },
                },
                {
                  head: 'POLISHING', name: 'Polishing', method: 'QTY', sortOrder: 0,
                  lines: {
                    create: [
                      L('THINNER', { qty: 2, rate: 25, unit: 'LTR' }),
                      L('SEALER', { qty: 2, rate: 28, unit: 'LTR' }),
                      L('LACQUER', { qty: 2, rate: 30, unit: 'LTR' }),
                      L('ROUGH CLOTH', { qty: 2, rate: 7, unit: 'PCS' }),
                      L('SANDING PAPER', { qty: 1.5, rate: 80, unit: 'PCS' }),
                    ],
                  },
                },
                {
                  head: 'PACKAGING', name: 'Packaging', method: 'QTY', sortOrder: 0,
                  lines: {
                    create: [
                      L('BUBBLE', { qty: 0.88, rate: 230, unit: 'MTR' }),
                      L('FOAM', { qty: 0.78, rate: 210, unit: 'MTR' }),
                      L('CARTON 7PLY', { qty: 1, rate: 580, unit: 'PCS' }),
                      L('CORNERS', { qty: 8, rate: 2.8, unit: 'PCS' }),
                    ],
                  },
                },
                {
                  head: 'LABOUR', name: 'Labour', method: 'QTY', sortOrder: 0,
                  lines: {
                    create: [
                      L('CNC LABOUR', { qty: 1, rate: 100, unit: 'LOT' }),
                      L('CARVING LABOUR', { qty: 1, rate: 260, unit: 'LOT' }),
                      L('MANUFACTURING LABOUR', { qty: 1, rate: 500, unit: 'LOT' }),
                      L('POLISHING LABOUR', { qty: 1, rate: 428, unit: 'LOT' }),
                      L('PACKAGING LABOUR', { qty: 1, rate: 180, unit: 'LOT' }),
                      L('LOADING LABOUR', { qty: 1, rate: 110, unit: 'LOT' }),
                    ],
                  },
                },
                {
                  head: 'FORWARDING', name: 'Forwarding', method: 'QTY', sortOrder: 0,
                  lines: {
                    create: [
                      L('CHA', { qty: 1, rate: 98, unit: 'LOT' }),
                      L('FORWARDER', { qty: 1, rate: 580, unit: 'LOT' }),
                      L('ICD', { qty: 1, rate: 136, unit: 'LOT' }),
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  });

  // --- Operations reference data ------------------------------------------
  const sequences = [
    { key: 'PI', prefix: 'PI', useYear: true },
    { key: 'ORD', prefix: 'ORD', useYear: true },
    // Domestic paperwork is numbered independently of the export series.
    { key: 'DPI', prefix: 'DPI', useYear: true },
    { key: 'DORD', prefix: 'DORD', useYear: true },
    { key: 'OP', prefix: 'OP', useYear: false },
    // Invoices carry the year, exactly as the PI/ORD series do — an invoice series is
    // quoted by financial year. Export and domestic are numbered independently, the same
    // split as PI/DPI. These MUST match YEAR_KEYS in lib/numbering.ts.
    { key: 'INV', prefix: 'INV', useYear: true },
    { key: 'DINV', prefix: 'DINV', useYear: true },
    // Shipments and packing lists are internal handles, so they stay flat.
    { key: 'SHP', prefix: 'SHP', useYear: false },
    { key: 'PKL', prefix: 'PKL', useYear: false },
  ];
  for (const s of sequences) {
    await prisma.docSequence.upsert({ where: { key: s.key }, update: { prefix: s.prefix, useYear: s.useYear }, create: s });
  }

  // The boxes an exporter books. Admin-defined DATA, seeded from the shipping engine the
  // same way BUILTIN_METHODS seeds the cost formulas — a new box size is a row, not a
  // release. Configuration, so a wipe leaves it alone.
  for (const c of BUILTIN_CONTAINER_TYPES) {
    await prisma.containerType.upsert({
      where: { code: c.code },
      // Only the description is refreshed. Capacities are deliberately NOT overwritten:
      // a line's own limits differ, and re-running the seed must not undo the Admin's edit.
      update: { name: c.name, sortOrder: c.sortOrder },
      create: { ...c },
    });
  }

  const suppliers = [
    { code: 'SUP-WOOD', name: 'Sharma Timber Traders', type: 'MATERIAL', contactName: 'Ramesh Sharma', phone: '+91 98290 11111', gstNo: '08ABCDE1234F1Z5', address: 'Jodhpur, Rajasthan', paymentTerms: '30 days' },
    { code: 'SUP-METAL', name: 'Metal Craft Works', type: 'MATERIAL', contactName: 'Iqbal Khan', phone: '+91 98290 22222', gstNo: '08MNOPQ5678R1Z2', address: 'Jodhpur, Rajasthan', paymentTerms: '15 days' },
    { code: 'JOB-POLISH', name: 'Glaze Polishing Co.', type: 'JOBWORK', contactName: 'Suresh', phone: '+91 98290 33333', address: 'Jodhpur, Rajasthan', paymentTerms: 'On delivery' },
    { code: 'JOB-CARVE', name: 'Precision Carving', type: 'JOBWORK', contactName: 'Mohan Lal', phone: '+91 98290 44444', address: 'Jodhpur, Rajasthan', paymentTerms: 'On delivery' },
    { code: 'JOB-POWDER', name: 'Shakti Powder Coating', type: 'JOBWORK', contactName: 'Vikram Singh', phone: '+91 98290 55555', address: 'Boranada, Jodhpur', paymentTerms: '15 days' },
  ];
  for (const s of suppliers) {
    await prisma.supplier.upsert({ where: { code: s.code }, update: s, create: s });
  }

  // --- Stage lines (production routes) ------------------------------------
  // A product is assigned one stage line; each order line snapshots its steps.
  /** How long each stage usually takes, so a generated schedule is believable. */
  const STAGE_DAYS: Record<string, number> = { 'Raw joining': 4, 'Raw sanding': 2, 'Polishing': 3, 'Accessory fitting': 2, 'QC': 1, 'Packaging': 1, 'Powder coating': 3, 'Fitting': 2, 'Packing': 1};
  const stageLines = [
    { code: 'X', name: 'Wood line', isDefault: true, steps: ['Raw joining', 'Raw sanding', 'Polishing', 'Accessory fitting', 'QC', 'Packaging'] },
    { code: 'Y', name: 'Metal line', isDefault: false, steps: ['Raw joining', 'Powder coating', 'Fitting', 'QC', 'Packing'] },
  ];
  const stageLineId: Record<string, number> = {};
  for (const sl of stageLines) {
    const existing = await prisma.stageLine.findUnique({ where: { code: sl.code } });
    const rec = existing
      ? await prisma.stageLine.update({ where: { code: sl.code }, data: { name: sl.name, isDefault: sl.isDefault, isActive: true } })
      : await prisma.stageLine.create({ data: { code: sl.code, name: sl.name, isDefault: sl.isDefault } });
    // Keep the step list in step with the seed definition.
    await prisma.stageLineStep.deleteMany({ where: { stageLineId: rec.id } });
    for (let i = 0; i < sl.steps.length; i++) {
      await prisma.stageLineStep.create({ data: { stageLineId: rec.id, name: sl.steps[i], sortOrder: i, defaultDays: STAGE_DAYS[sl.steps[i]] ?? null } });
    }
    stageLineId[sl.code] = rec.id;
  }
  // The demo almirah travels the wood line.
  await prisma.product.updateMany({ where: { factoryCode: 'AB-00123' }, data: { stageLineId: stageLineId['X'] } });

  const rawItems = [
    { code: 'RM-MANGO', name: 'Mango Wood', category: 'Wood', unit: 'CFT', reorderLevel: 50, openingQty: 200 },
    { code: 'RM-OAK', name: 'Oak Wood', category: 'Wood', unit: 'SQFT', reorderLevel: 40, openingQty: 120 },
    { code: 'RM-IRON', name: 'Powdercoated Iron', category: 'Metal', unit: 'KGS', reorderLevel: 100, openingQty: 300 },
    { code: 'RM-PLY6', name: 'Ply 6mm', category: 'Ply', unit: 'SQFT', reorderLevel: 60, openingQty: 90 },
    { code: 'RM-GLASS', name: 'Glass 4mm', category: 'Glass', unit: 'SQFT', reorderLevel: 20, openingQty: 15 },
  ];
  for (const r of rawItems) {
    await prisma.rawItem.upsert({ where: { code: r.code }, update: r, create: r });
  }

  // --- Company: who we are, and the state the tax split depends on --------
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
    },
  });

  // Existing products predate GST classification; furniture is 9403 at 18%.
  await prisma.product.updateMany({ where: { hsnCode: null }, data: { hsnCode: '9403', gstRatePct: 18 } });

  // --- Manforce: settings, trades, statutory components -------------------
  await seedManforceDefaults(prisma);
  const migrated = await migrateTypedWorkers(prisma);
  if (migrated.workers || migrated.entries) {
    console.log(`  Manforce: created ${migrated.workers} worker(s) from ${migrated.entries} typed wage entr(ies).`);
  }

  console.log('Seed complete.');
  console.log('  Admin login : admin@saraswati.local / admin123');
  console.log('  Manager login: manager@saraswati.local / manager123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
