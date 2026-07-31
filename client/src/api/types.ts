export interface UserRoleRef {
  id: number;
  name: string | null;
  /**
   * Present on `/users` but not on `/auth/me`, which reports only what the signed-in user
   * effectively holds — a deactivated role has already resolved to no permissions there, so
   * saying it is inactive would be a distinction without a difference.
   */
  isActive?: boolean;
}

export interface User {
  id: number;
  name: string;
  email: string;
  /**
   * The role this account holds, or null for an account that has been created but not yet
   * given one — which means no permissions at all rather than some default rank.
   */
  role: UserRoleRef | null;
  /** Holds every permission regardless of role. Cannot be true of nobody. */
  isOwner: boolean;
  /**
   * The resolved permission keys. A HINT for hiding what cannot be done — never a
   * safeguard. Every route re-checks, because a list handed to a browser is a list the
   * browser can edit.
   */
  permissions: string[];
  isActive?: boolean;
}

/** One entry of the catalogue, as `GET /roles/permissions` returns it. */
export interface PermissionDef {
  key: string;
  module: string;
  label: string;
  what: string;
  allows: string[];
  blocks: string[];
  risk: 'normal' | 'sensitive' | 'destructive';
  requires?: string[];
}

export interface Role {
  id: number;
  name: string;
  description: string;
  isActive: boolean;
  users: number;
  permissions: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface Currency {
  id: number;
  code: string;
  name: string;
  symbol: string;
  rateToBase: number;
  isBase: boolean;
  isActive: boolean;
}

export interface Unit {
  id: number;
  code: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export interface AttributeValue {
  id: number;
  type: string;
  value: string;
  code?: string | null;
  sortOrder: number;
  isActive: boolean;
}

export interface Buyer {
  id: number;
  code: string;
  name: string;
  country?: string | null;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  isActive: boolean;
  /** Trade or end customer. Independent of `market`, so all four combinations exist. */
  channel: 'B2B' | 'B2C' | string;
  /** OVERSEAS sells at FOB in their currency, zero-rated; DOMESTIC at Non-FOB with GST. */
  market: 'OVERSEAS' | 'DOMESTIC' | string;
  gstNo?: string | null;
  /** Compared with the company's state to decide CGST+SGST versus IGST. */
  state?: string | null;
}

/** Who WE are. Singleton, edited in Master Data -> Company. */
export interface Company {
  id: number;
  legalName: string;
  tradeName?: string | null;
  addressL1?: string | null;
  addressL2?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  country: string;
  gstNo?: string | null;
  panNo?: string | null;
  iecNo?: string | null;
  cinNo?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  bankDetails?: string | null;
  /** Letterhead logo, a filename in uploads. Served from `/uploads/<name>`. */
  logoFilename?: string | null;
  /** Present when saving left the tax split in a state worth mentioning. */
  warning?: string;
}

export interface Meta {
  heads: { code: string; label: string; order: number }[];
  methods: {
    code: string;
    label: string;
    measureUnit: string;
    expression: string;
    dims: ('L' | 'W' | 'H')[];
    usesWeight: boolean;
    usesWastage: boolean;
    dimUnit?: 'IN' | 'CM' | null;
    hint: string;
  }[];
  roles: string[];
  attributeTypes: { type: string; label: string }[];
  relationTypes: { code: string; label: string }[];
  productStatuses: string[];
}

export interface CostLine {
  id?: number;
  name: string;
  qty: number;
  wastagePct: number;
  actualL?: number | null;
  actualW?: number | null;
  actualH?: number | null;
  costL?: number | null;
  costW?: number | null;
  costH?: number | null;
  actualWeight?: number | null;
  unit?: string | null;
  rate: number;
  sortOrder?: number;
  /**
   * Which production stage a LABOUR line pays for. Reference only — it seeds the
   * in-house piece rate when an order snapshots its stages, and has no effect at all
   * on the costing roll-up.
   */
  stageStepId?: number | null;
  measure?: number;
  amount?: number;
}

export interface CostGroup {
  id?: number;
  head: string;
  name: string;
  method: string;
  dimUnit?: string | null;
  sortOrder?: number;
  notes?: string | null;
  lines: CostLine[];
  total?: number;
}

export interface CostSummary {
  headTotals: Record<string, number>;
  exFactory: number;
  forwarding: number;
  factoryExpense: number;
  margin: number;
  fob: number;
  nonFobFactoryExpense: number;
  nonFobMargin: number;
  nonFob: number;
  factoryExpensePct: number;
  marginPct: number;
}

export interface CostSheet {
  id?: number;
  currencyId?: number | null;
  currency?: Currency | null;
  factoryExpensePct: number;
  marginPct: number;
  notes?: string | null;
  groups: CostGroup[];
  summary?: CostSummary;
  updatedAt?: string;
  createdAt?: string;
}

export interface ProductBuyerLink {
  id?: number;
  buyerId: number;
  buyerCode?: string | null;
  buyer?: Buyer;
}

export interface RelatedLink {
  id?: number;
  relatedId: number;
  relation: string;
  note?: string | null;
  product?: { id: number; factoryCode: string; name: string; primaryImage?: string | null };
}

export interface ProductImage {
  id: number;
  url: string;
  filename: string;
  originalName?: string | null;
  isPrimary: boolean;
  caption?: string | null;
  sortOrder: number;
}

export interface ProductSummary {
  id: number;
  factoryCode: string;
  name: string;
  alias?: string | null;
  status: string;
  productType?: string | null;
  size?: string | null;
  colour?: string | null;
  material?: string | null;
  unit?: string | null;
  buyers: { name: string; code: string; buyerCode?: string | null }[];
  primaryImage?: string | null;
  currency?: { code: string; symbol: string } | null;
  exFactory?: number | null;
  fob?: number | null;
  nonFob?: number | null;
  updatedAt: string;
}

export interface ProductDetail {
  id: number;
  factoryCode: string;
  name: string;
  alias?: string | null;
  status: string;
  description?: string | null;
  notes?: string | null;
  itemTypeId?: number | null;
  productTypeId?: number | null;
  sizeId?: number | null;
  colourId?: number | null;
  materialId?: number | null;
  finishId?: number | null;
  unitId?: number | null;
  stageLineId?: number | null;
  prodLengthIn?: number | null;
  prodWidthIn?: number | null;
  prodHeightIn?: number | null;
  netWeightKg?: number | null;
  grossWeightKg?: number | null;
  packLengthIn?: number | null;
  packWidthIn?: number | null;
  packHeightIn?: number | null;
  piecesPerCarton?: number | null;
  volumeBeforePackingCbm?: number | null;
  volumeAfterPackingCbm?: number | null;
  /** Tax classification for domestic sales. No effect on costing or on an export. */
  hsnCode?: string | null;
  gstRatePct?: number;
  itemType?: AttributeValue | null;
  productType?: AttributeValue | null;
  size?: AttributeValue | null;
  colour?: AttributeValue | null;
  material?: AttributeValue | null;
  finish?: AttributeValue | null;
  unit?: Unit | null;
  stageLine?: { id: number; code: string; name: string; steps: { id: number; name: string; sortOrder: number }[] } | null;
  createdBy?: { id: number; name: string } | null;
  buyers: ProductBuyerLink[];
  images: ProductImage[];
  related: RelatedLink[];
  costSheet?: CostSheet | null;
  /**
   * True when the sheet was WITHHELD for want of `products.costing.view`, as opposed to the
   * product simply not having one. The difference matters on screen: "no costing sheet" and
   * "you may not see the costing sheet" are different statements and only one of them is true.
   */
  costingHidden?: boolean;
  updatedAt: string;
  createdAt: string;
}
