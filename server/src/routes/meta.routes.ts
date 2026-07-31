import { Router } from 'express';
import { COST_HEADS, HEAD_META } from '../lib/costing';
import { prisma } from '../db';
import { asyncHandler, guardIdParams } from '../lib/http';
import { methodToApi, rowToMethodDef } from '../lib/methods';

export const ATTRIBUTE_TYPES = [
  { type: 'PRODUCT_TYPE', label: 'Product Type' },
  { type: 'ITEM_TYPE', label: 'Item Type' },
  { type: 'SIZE', label: 'Size' },
  { type: 'COLOUR', label: 'Colour' },
  { type: 'MATERIAL', label: 'Material' },
  { type: 'FINISH', label: 'Finish' },
];

export const RELATION_TYPES = [
  { code: 'VARIANT', label: 'Variant' },
  { code: 'PART', label: 'Part / Component' },
  { code: 'ACCESSORY', label: 'Accessory' },
  { code: 'SET', label: 'Same Set / Collection' },
];

export const PRODUCT_STATUSES = ['Draft', 'Active', 'Discontinued'];

const router = Router();
// A route param here is always a database id — see guardIdParams.
guardIdParams(router);

// Reference data the frontend needs to render forms and filters consistently.
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const methodRows = await prisma.costMethod.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
    res.json({
      heads: COST_HEADS.map((h) => ({ code: h, ...HEAD_META[h] })),
      methods: methodRows.map((r) => methodToApi(rowToMethodDef(r))),
      // Roles used to be listed here as four fixed names. They are now records created by
      // the Admin, so the client reads them from /roles instead.
      attributeTypes: ATTRIBUTE_TYPES,
      relationTypes: RELATION_TYPES,
      productStatuses: PRODUCT_STATUSES,
    });
  })
);

export default router;
