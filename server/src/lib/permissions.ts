/**
 * The permission catalogue — what a role can be granted, and what each grant means.
 *
 * This file is the SINGLE AUTHORITY for which permissions exist. Roles are data (a row
 * per role, a row per granted key), but the catalogue is CODE, and deliberately so: a
 * permission is only real if a route checks it, and a route can only check a key that is
 * declared here. Were the catalogue a table, an Admin could create "orders.approve" in
 * the picker, tick it, and be told they had granted something — enforcing nothing. So
 * `verify.ts` asserts both directions: every key referenced by a route exists here, and
 * every key here is referenced by at least one route.
 *
 * The prose is part of the contract, not decoration. The Roles screen renders `what`,
 * `allows` and `blocks` beside every checkbox, because the person granting a permission is
 * usually not the person who wrote the route, and "orders.pricing" tells them nothing about
 * whether it lets somebody re-price a confirmed order. Write these for that reader:
 *
 * - `what`    one paragraph, plain English, no table or route names.
 * - `allows`  concrete things that become possible, naming the screen where they happen.
 * - `blocks`  what it still does NOT give them — the near-miss a granter will assume.
 * - `risk`    'destructive' loses data or money, 'sensitive' discloses it, else 'normal'.
 * - `requires` keys the grant is meaningless without. Editing implies viewing: granted
 *              alone, an edit permission produces a screen the user cannot open. The UI
 *              ticks these automatically and says why.
 *
 * `requires` is a UI and validation convenience, NOT an enforcement mechanism. Routes state
 * every key they need. A view check on a detail route is not skipped because some edit
 * permission implies it — that would make enforcement depend on this file's shape.
 */

/**
 * How much damage a mistaken grant does. Drives a badge on the picker and nothing else —
 * no route behaves differently because of it.
 */
export type PermissionRisk = 'normal' | 'sensitive' | 'destructive';

export interface PermissionDef {
  key: string;
  /** Group heading on the Roles screen. Matches the sidebar wording, not the file layout. */
  module: string;
  label: string;
  what: string;
  allows: string[];
  blocks: string[];
  risk: PermissionRisk;
  requires?: string[];
}

/**
 * Module order as the Roles screen shows it — the sidebar's order, so somebody building a
 * role walks the app in the shape they already know rather than in route-file order.
 */
export const PERMISSION_MODULES = [
  'Orders',
  'Proformas & Quotations',
  'Production board',
  'Material sheets',
  'Suppliers & raw stock',
  'Finished stock & packing',
  'Shipments',
  'Invoices',
  'Money',
  'Manforce',
  'Products',
  'Master data',
  'Settings & users',
] as const;

export type PermissionModule = (typeof PERMISSION_MODULES)[number];

export const PERMISSIONS: readonly PermissionDef[] = [
  // -------------------------------------------------------------------------
  // Orders — the hub. Almost everybody needs orders.view; it is the front door.
  // -------------------------------------------------------------------------
  {
    key: 'orders.view',
    module: 'Orders',
    label: 'See orders',
    what:
      'Open the order list and any order page. The order page is the hub of the app, so this is the front door to most day-to-day work — but each of its tabs is separately permissioned, and a user with only this permission sees the order, its products and its quantities without the money, the board detail or the paperwork.',
    allows: [
      'Open Orders in the sidebar and search the list',
      'Open any order and see its buyer, products, quantities and delivery dates',
      'See the order status tag and its expected delivery',
    ],
    blocks: [
      'Seeing the order value, buyer balance or anything on the Money tab',
      'Changing anything on the order',
      'Seeing deleted orders in the Trash drawer',
    ],
    risk: 'normal',
  },
  {
    key: 'orders.create',
    module: 'Orders',
    label: 'Create orders directly',
    what:
      'Create an order from scratch, without a proforma behind it. Most orders should arrive by accepting a proforma instead, which carries the agreed prices and charges across automatically; this is for the walk-in and telephone jobs that never had a quotation.',
    allows: ['Use New Order on the orders list', 'Set the buyer, currency, products, quantities and prices'],
    blocks: [
      'Accepting a proforma — that is a separate permission',
      'Editing an order after it is created',
    ],
    risk: 'normal',
    requires: ['orders.view'],
  },
  {
    key: 'orders.edit',
    module: 'Orders',
    label: 'Edit order details',
    what:
      'Change an existing order\'s products, quantities, dates and buyer. Quantities cannot drop below what the factory has already made — the board is checked as the change is saved. Changing the buyer or the currency also restates the exchange rate and the tax treatment of the whole order, so this is a bigger action than it looks.',
    allows: [
      'Add or remove products on an order, change quantities and delivery dates',
      'Change the buyer or the currency, which re-derives the rate and the GST treatment',
    ],
    blocks: [
      'Changing unit prices, discounts or charges — that is Edit order pricing',
      'Reducing a quantity below what is already in production or finished',
      'Closing, cancelling or reopening the order',
    ],
    risk: 'normal',
    requires: ['orders.view'],
  },
  {
    key: 'orders.pricing',
    module: 'Orders',
    label: 'Edit order pricing',
    what:
      'Change what an order is worth: unit prices, line discounts, and document-level charges such as freight or insurance. This directly moves what the buyer owes, and every change is written to the order\'s History tab with the old value and who made it. Separate from Edit order details so a coordinator can fix a quantity or a date without being able to re-price the job.',
    allows: [
      'Change unit prices and per-line discounts on an order',
      'Add, edit or remove freight, insurance and other charges',
      'Change GST rates on a domestic order',
    ],
    blocks: ['Recording what the buyer has actually paid', 'Seeing the buyer\'s overall balance'],
    risk: 'sensitive',
    requires: ['orders.view'],
  },
  {
    key: 'orders.status',
    module: 'Orders',
    label: 'Close or cancel orders',
    what:
      'Mark an order Closed or Cancelled. These are the only two statuses a person decides — the other four are worked out from the production board and what has shipped. Cancelling is significant beyond the order itself: a cancelled order drops out of every financial total, so the buyer\'s receivable and the order book both change.',
    allows: ['Use Close and Cancel on the order page'],
    blocks: [
      'Setting Confirmed, In Production, Ready or Shipped — those follow the board',
      'Reopening an order once it is closed or cancelled',
    ],
    risk: 'sensitive',
    requires: ['orders.view'],
  },
  {
    key: 'orders.reopen',
    module: 'Orders',
    label: 'Reopen closed orders',
    what:
      'Take an order back out of Closed or Cancelled and let its status be worked out from the board again. A cancelled order that is reopened re-enters the financial totals it had dropped out of, so a buyer\'s balance can move because of this.',
    allows: ['Use Reopen on a closed or cancelled order'],
    blocks: ['Closing or cancelling in the first place'],
    risk: 'sensitive',
    requires: ['orders.view'],
  },
  {
    key: 'orders.schedule.view',
    module: 'Orders',
    label: 'See the production plan',
    what:
      'See the planned start and finish dates for each stage of an order, and the delivery verdict that compares the plan with what the board has actually finished — on time, at risk, or overdue. The plan is an overlay: it never changes where pieces actually are.',
    allows: [
      'See the Schedule section on an order and the per-stage plan-versus-actual status',
      'Open the Delivery Status list in Operations',
    ],
    blocks: ['Changing any planned date'],
    risk: 'normal',
    requires: ['orders.view'],
  },
  {
    key: 'orders.schedule.edit',
    module: 'Orders',
    label: 'Set the production plan',
    what:
      'Set planned start and finish dates per stage, by hand or by letting the app lay the order out backwards from its delivery date using each stage\'s typical duration. Changing the plan changes whether jobs are reported as at risk or overdue, which is what the factory acts on each morning.',
    allows: ['Edit planned stage dates on an order', 'Use Auto-schedule to lay an order out from its delivery date'],
    blocks: ['Moving pieces on the board — a plan is an estimate, not progress'],
    risk: 'normal',
    requires: ['orders.view', 'orders.schedule.view'],
  },
  {
    key: 'orders.attachments.view',
    module: 'Orders',
    label: 'See and download order paperwork',
    what:
      'See the documents filed against an order and download them — the buyer\'s purchase order, bills of lading, customs forms, packing lists, inspection certificates and drawings. Downloads are scoped to the order they are filed under, so one order\'s link can never fetch another\'s file.',
    allows: ['Open the Paperwork tab on an order', 'Download any attachment filed there'],
    blocks: ['Adding or removing attachments'],
    risk: 'sensitive',
    requires: ['orders.view'],
  },
  {
    key: 'orders.attachments.manage',
    module: 'Orders',
    label: 'Add and remove order paperwork',
    what:
      'Upload documents to an order and remove them. Removal is permanent and immediate — an attachment has no trash and no history, because leaving orphaned files on disk would be worse than losing the row. Uploads are checked by their actual contents, not their filename, so a file whose insides contradict its extension is refused.',
    allows: ['Upload documents on the Paperwork tab', 'Delete an attachment permanently'],
    blocks: ['Recovering an attachment once deleted'],
    risk: 'destructive',
    requires: ['orders.view', 'orders.attachments.view'],
  },
  {
    key: 'orders.documents',
    module: 'Orders',
    label: 'Print order documents',
    what:
      'Generate and download the PDF for an order. The document draws its letterhead from the Company record and its figures from the same pricing engine the rest of the app uses, so it cannot print a total the order page disagrees with.',
    allows: ['Download the order PDF'],
    blocks: ['E-mailing it to the buyer', 'Changing anything the document shows'],
    risk: 'sensitive',
    requires: ['orders.view'],
  },
  {
    key: 'orders.history',
    module: 'Orders',
    label: 'See who changed prices',
    what:
      'See the History tab: every change to a price or a rate on this order, with the old value, the new value, who made it and when. Only money and rates are recorded — a log of every keystroke would bury the one entry anybody ever needs.',
    allows: ['Open the History tab on an order and see past price changes with their author'],
    blocks: ['Changing or removing a history entry — the log is append-only for everyone'],
    risk: 'sensitive',
    requires: ['orders.view'],
  },
  {
    key: 'orders.delete',
    module: 'Orders',
    label: 'Move orders to trash',
    what:
      'Send an order to the trash. Nothing is destroyed: the record survives, drops out of every list and every financial total, and can be restored intact. This is the safe delete and the one to grant if you are unsure.',
    allows: ['Delete an order from the list or its own page'],
    blocks: ['Deleting it permanently', 'Restoring it afterwards'],
    risk: 'destructive',
    requires: ['orders.view'],
  },
  {
    key: 'orders.restore',
    module: 'Orders',
    label: 'Restore orders from trash',
    what:
      'Open the Trash drawer on the orders list, see what has been deleted, and put an order back. A restored order re-enters every list and every total it had dropped out of.',
    allows: ['Open the Trash drawer', 'Restore a deleted order'],
    blocks: ['Deleting permanently'],
    risk: 'normal',
    requires: ['orders.view'],
  },
  {
    key: 'orders.purge',
    module: 'Orders',
    label: 'Permanently delete orders',
    what:
      'Destroy a trashed order and everything hanging off it for good — its board history, its schedule, its paperwork. There is no undo, no waiting period and no automatic purge; nothing here disappears because time passed. Grant this to one or two people at most.',
    allows: ['Permanently delete an order from the Trash drawer'],
    blocks: ['Nothing — this is the end of the line for that record'],
    risk: 'destructive',
    requires: ['orders.view', 'orders.restore'],
  },

  // -------------------------------------------------------------------------
  // Proformas — the sales cycle before an order exists.
  // -------------------------------------------------------------------------
  {
    key: 'proformas.view',
    module: 'Proformas & Quotations',
    label: 'See proformas and quotations',
    what:
      'Open the proforma list and any proforma. Overseas buyers get a Proforma Invoice priced FOB in their currency; domestic buyers get a Quotation priced in rupees with GST. They are the same record with different treatment, and this permission covers both.',
    allows: ['Open Proformas in the sidebar', 'See any proforma with its products, prices and status'],
    blocks: ['Creating, editing, sending or accepting one'],
    risk: 'sensitive',
  },
  {
    key: 'proformas.create',
    module: 'Proformas & Quotations',
    label: 'Create proformas',
    what:
      'Draft a new proforma or quotation for a buyer. The buyer\'s market decides the whole shape of the document — price basis, tax treatment, numbering and title — so choosing the buyer is most of the work.',
    allows: ['Use New Proforma', 'Set the buyer, products, quantities, prices, discounts and charges'],
    blocks: ['Sending it to the buyer', 'Turning it into an order'],
    risk: 'normal',
    requires: ['proformas.view'],
  },
  {
    key: 'proformas.edit',
    module: 'Proformas & Quotations',
    label: 'Edit proformas',
    what:
      'Change a proforma\'s products, prices, discounts and charges while it is still a draft. Changing the buyer restates the exchange rate and the tax snapshot, so a rupee quotation moved to an overseas buyer re-prices end to end rather than silently keeping rate 1.',
    allows: ['Edit any field on a draft proforma, including prices and charges'],
    blocks: ['Editing one that has been sent, without reopening it first', 'Accepting or rejecting it'],
    risk: 'sensitive',
    requires: ['proformas.view'],
  },
  {
    key: 'proformas.send',
    module: 'Proformas & Quotations',
    label: 'Mark proformas as sent',
    what:
      'Move a proforma from draft to sent, which is the record that it went to the buyer. A sent proforma is no longer freely editable — it has to be reopened first, so the version the buyer saw is not quietly rewritten underneath them.',
    allows: ['Use Send on a draft proforma'],
    blocks: ['Actually e-mailing it — that is Send proformas by e-mail', 'Accepting it on the buyer\'s behalf'],
    risk: 'normal',
    requires: ['proformas.view'],
  },
  {
    key: 'proformas.accept',
    module: 'Proformas & Quotations',
    label: 'Accept proformas into orders',
    what:
      'Turn an accepted proforma into a live order. This is the only route by which most orders come into being, and it happens once per proforma — the app refuses a second attempt. Accepting copies the agreed prices, discounts and charges onto the order rather than pointing at them, so a later revision of the proforma cannot change what was agreed.',
    allows: ['Use Accept on a sent proforma, creating the order behind it'],
    blocks: ['Editing the order afterwards', 'Accepting a proforma whose lines are not linked to products'],
    risk: 'sensitive',
    requires: ['proformas.view'],
  },
  {
    key: 'proformas.reject',
    module: 'Proformas & Quotations',
    label: 'Reject proformas',
    what:
      'Record that the buyer said no, with the reason, and stop the proforma there. Kept separate from accepting because the two are decisions of quite different weight.',
    allows: ['Use Reject on a sent proforma and record why'],
    blocks: ['Reopening it to try again'],
    risk: 'normal',
    requires: ['proformas.view'],
  },
  {
    key: 'proformas.reopen',
    module: 'Proformas & Quotations',
    label: 'Reopen proformas',
    what:
      'Put a sent or rejected proforma back to draft so it can be revised and sent again. This is the ordinary way a negotiation proceeds.',
    allows: ['Use Reopen and return the proforma to draft'],
    blocks: ['Reopening one that has already become an order'],
    risk: 'normal',
    requires: ['proformas.view'],
  },
  {
    key: 'proformas.documents',
    module: 'Proformas & Quotations',
    label: 'Print proformas',
    what:
      'Download the proforma or quotation PDF, product photos included. A domestic quotation gains HSN codes, GST columns, a place of supply and the CGST/SGST split; an export document is unchanged from what it has always been.',
    allows: ['Download the proforma PDF'],
    blocks: ['E-mailing it'],
    risk: 'sensitive',
    requires: ['proformas.view'],
  },
  {
    key: 'proformas.email',
    module: 'Proformas & Quotations',
    label: 'Send proformas by e-mail',
    what:
      'Get an e-mail draft for a proforma — either a mail link that opens your mail program with the subject and body filled in, or a downloadable draft file that carries the PDF as a real attachment and opens ready to edit. Nothing is sent by the app itself; you still press send.',
    allows: ['Use Send by e-mail on a proforma', 'Download the draft with the PDF attached'],
    blocks: ['Sending mail without your own mail program', 'Editing the proforma'],
    risk: 'sensitive',
    requires: ['proformas.view', 'proformas.documents'],
  },
  {
    key: 'proformas.delete',
    module: 'Proformas & Quotations',
    label: 'Move proformas to trash',
    what: 'Send a proforma to the trash. The record survives and can be restored; nothing about an order it already created is affected.',
    allows: ['Delete a proforma'],
    blocks: ['Deleting it permanently', 'Restoring it'],
    risk: 'destructive',
    requires: ['proformas.view'],
  },
  {
    key: 'proformas.restore',
    module: 'Proformas & Quotations',
    label: 'Restore proformas from trash',
    what: 'Open the Trash drawer on the proforma list and put a deleted proforma back.',
    allows: ['Open the Trash drawer', 'Restore a deleted proforma'],
    blocks: ['Deleting permanently'],
    risk: 'normal',
    requires: ['proformas.view'],
  },
  {
    key: 'proformas.purge',
    module: 'Proformas & Quotations',
    label: 'Permanently delete proformas',
    what: 'Destroy a trashed proforma for good. No undo, and only possible from the trash.',
    allows: ['Permanently delete a proforma from the Trash drawer'],
    blocks: ['Nothing — the record is gone'],
    risk: 'destructive',
    requires: ['proformas.view', 'proformas.restore'],
  },

  // -------------------------------------------------------------------------
  // Production board — where pieces are. The daily screen.
  // -------------------------------------------------------------------------
  {
    key: 'board.view',
    module: 'Production board',
    label: 'See the production board',
    what:
      'See where every piece of an order is: waiting to start, at each stage of its route, or finished. This is worked out from the movement history rather than stored, so it is always the truth about the floor.',
    allows: ['Open the Production tab on an order and see the per-stage piece counts', 'See which stages are outsourced and to whom'],
    blocks: ['Moving any pieces', 'Seeing the rates being earned per stage'],
    risk: 'normal',
    requires: ['orders.view'],
  },
  {
    key: 'board.move',
    module: 'Production board',
    label: 'Move pieces forward',
    what:
      'Record work as done: release pieces from waiting into the first stage, advance them between stages, and complete them out of the last stage into finished goods. This is the main daily action on the floor. A move that spans several stages is recorded as one movement per stage crossed, so each stage\'s count — and the jobwork owed for it — stays exact.',
    allows: [
      'Use Clear a stage and the per-line move drawers on the board',
      'Release, advance and complete pieces, with a hand-over comment',
    ],
    blocks: [
      'Sending pieces backward for rework',
      'Undoing a movement once recorded',
      'Naming which workers did the work, which is what pays piece-rate wages',
    ],
    risk: 'normal',
    requires: ['orders.view', 'board.view'],
  },
  {
    key: 'board.reject',
    module: 'Production board',
    label: 'Send pieces back for rework',
    what:
      'Push pieces backward to an earlier stage because they failed inspection. Deliberately separate from moving forward: a rejection is a judgement about quality, and it has a money consequence — work redone is earned again, by the vendor or the worker who redoes it, because the work genuinely happened twice.',
    allows: ['Record a rejection back to any earlier stage, with a comment'],
    blocks: ['Moving pieces forward', 'Undoing the rejection afterwards'],
    risk: 'normal',
    requires: ['orders.view', 'board.view'],
  },
  {
    key: 'board.undo',
    module: 'Production board',
    label: 'Undo board movements',
    what:
      'Delete the most recent movement on a line, for when something was entered wrongly. Only the newest movement can be undone, so history cannot be rewritten from the middle. Undoing has knock-on effects: finished stock un-does itself, and the jobwork or wages that the movement earned disappear with it.',
    allows: ['Undo the latest movement on an order line, and its hand-over photos with it'],
    blocks: ['Undoing anything but the newest movement on that line'],
    risk: 'destructive',
    requires: ['orders.view', 'board.view'],
  },
  {
    key: 'board.photos',
    module: 'Production board',
    label: 'Attach hand-over photos',
    what:
      'Upload proof-of-condition photographs against a hand-over and remove them. These are what a dispute about damage is settled with, so being able to delete them matters as much as being able to add them.',
    allows: ['Attach photos to a hand-over as it is recorded', 'Delete a photo from a movement'],
    blocks: ['Recording the movement itself'],
    risk: 'normal',
    requires: ['orders.view', 'board.view'],
  },
  {
    key: 'board.workers',
    module: 'Production board',
    label: 'Name who did the work',
    what:
      'Attribute a clearance to the workers who did it, with a piece count each. This is how piece-rate wages are earned — there is no separate wage entry screen — so ticking a name here creates money owed to that person, priced at the stage\'s labour rate. Only a single-stage clearance can be attributed, because each stage is a different piece of work.',
    allows: ['Name workers and their piece counts when clearing a stage', 'Create the piece-rate earnings behind a worker\'s balance'],
    blocks: ['Setting the labour rate those pieces are priced at', 'Paying the worker'],
    risk: 'sensitive',
    requires: ['orders.view', 'board.view', 'board.move'],
  },
  {
    key: 'board.routing',
    module: 'Production board',
    label: 'Change an order\'s route and vendors',
    what:
      'Change which stages an order line goes through and which of them go out to a vendor rather than being done in-house. Any pattern is allowed — stages one to three in-house, four at a vendor, five and six back in-house. A line\'s route is frozen once pieces have started moving through it.',
    allows: ['Assign or clear a vendor per stage on an order line', 'Change a line\'s stage route before work starts'],
    blocks: ['Setting the rates for those stages', 'Changing the route after pieces have moved'],
    risk: 'normal',
    requires: ['orders.view', 'board.view'],
  },
  {
    key: 'board.rates',
    module: 'Production board',
    label: 'Set jobwork and labour rates',
    what:
      'Set what each stage pays — the jobwork rate for an outsourced stage and the labour rate for in-house piece work. These rates are what every clearance is multiplied by, so this permission decides what the factory owes its vendors and its workers. Changes are written to the order\'s History tab. A vendor stage with a zero rate is refused outright, because it would silently bill nothing.',
    allows: ['Set the jobwork rate on an outsourced stage', 'Set the labour rate on an in-house stage'],
    blocks: ['Paying anybody', 'Seeing the resulting totals unless you can also see money'],
    risk: 'sensitive',
    requires: ['orders.view', 'board.view'],
  },

  // -------------------------------------------------------------------------
  // Material sheets — the costing explosion for a product × quantity.
  // -------------------------------------------------------------------------
  {
    key: 'sheets.view',
    module: 'Material sheets',
    label: 'See material sheets',
    what:
      'Open a numbered material sheet: what a given quantity of a product needs, worked out from its cost sheet. A material sheet carries no progress — it is a shopping list, not a job card.',
    allows: ['Open Material Sheets in the sidebar and see any sheet'],
    blocks: ['Creating or deleting one'],
    risk: 'sensitive',
  },
  {
    key: 'sheets.create',
    module: 'Material sheets',
    label: 'Create material sheets',
    what: 'Generate a new numbered material sheet for a product and quantity.',
    allows: ['Use New Sheet and pick a product and quantity'],
    blocks: ['Editing a sheet after it is generated'],
    risk: 'normal',
    requires: ['sheets.view'],
  },
  {
    key: 'sheets.documents',
    module: 'Material sheets',
    label: 'Print material sheets',
    what: 'Download a material sheet as a PDF for the floor or the store.',
    allows: ['Download the sheet PDF'],
    blocks: ['Changing what it shows'],
    risk: 'sensitive',
    requires: ['sheets.view'],
  },
  {
    key: 'sheets.delete',
    module: 'Material sheets',
    label: 'Move material sheets to trash',
    what: 'Send a material sheet to the trash. It survives and can be restored.',
    allows: ['Delete a material sheet'],
    blocks: ['Deleting it permanently', 'Restoring it'],
    risk: 'destructive',
    requires: ['sheets.view'],
  },
  {
    key: 'sheets.restore',
    module: 'Material sheets',
    label: 'Restore material sheets',
    what: 'Open the Trash drawer on the sheets list and put a deleted sheet back.',
    allows: ['Open the Trash drawer', 'Restore a deleted sheet'],
    blocks: ['Deleting permanently'],
    risk: 'normal',
    requires: ['sheets.view'],
  },
  {
    key: 'sheets.purge',
    module: 'Material sheets',
    label: 'Permanently delete material sheets',
    what: 'Destroy a trashed material sheet for good.',
    allows: ['Permanently delete a sheet from the Trash drawer'],
    blocks: ['Nothing — the record is gone'],
    risk: 'destructive',
    requires: ['sheets.view', 'sheets.restore'],
  },

  // -------------------------------------------------------------------------
  // Suppliers & raw stock.
  // -------------------------------------------------------------------------
  {
    key: 'suppliers.view',
    module: 'Suppliers & raw stock',
    label: 'See suppliers',
    what:
      'Open the supplier list and any supplier, including the vendors that outsourced stages go to. Their outstanding balances are money and are covered separately.',
    allows: ['Open Suppliers in the sidebar and see contact and trade details'],
    blocks: ['Seeing what is owed to a supplier', 'Adding or editing one'],
    risk: 'normal',
  },
  {
    key: 'suppliers.manage',
    module: 'Suppliers & raw stock',
    label: 'Add and edit suppliers',
    what:
      'Create suppliers and jobwork vendors and edit their details. Deactivating a supplier hides it from new entry without touching the history of what they supplied. A supplier that is referenced cannot simply be deleted — the app names what refers to them instead.',
    allows: ['Create a supplier or vendor', 'Edit details, deactivate, or delete an unused one'],
    blocks: ['Recording a delivery from them', 'Paying them'],
    risk: 'normal',
    requires: ['suppliers.view'],
  },
  {
    key: 'rawitems.view',
    module: 'Suppliers & raw stock',
    label: 'See raw items',
    what:
      'See the catalogue of raw materials and bought-in items. An item can be flagged as being a finished product bought in rather than made, which is how bought-in goods reach finished stock through the ordinary supplier machinery.',
    allows: ['Open the raw item list and see units, descriptions and product links'],
    blocks: ['Adding or editing items', 'Seeing stock levels'],
    risk: 'normal',
  },
  {
    key: 'rawitems.manage',
    module: 'Suppliers & raw stock',
    label: 'Add and edit raw items',
    what:
      'Create and edit raw items, including linking one to a product to say "this purchased item IS that product, bought in rather than made". That link puts received quantities into finished stock, so it has reach beyond the store.',
    allows: ['Create and edit raw items', 'Link a raw item to a product as bought-in finished goods', 'Delete an unused item'],
    blocks: ['Recording receipts against them'],
    risk: 'normal',
    requires: ['rawitems.view'],
  },
  {
    key: 'stock.view',
    module: 'Suppliers & raw stock',
    label: 'See raw stock movements',
    what: 'See what has been received into the store and issued out of it, and the resulting stock position per item.',
    allows: ['Open Raw Stock in the sidebar and see receipts and issues'],
    blocks: ['Recording a receipt', 'Seeing what the supplier charged'],
    risk: 'normal',
  },
  {
    key: 'stock.manage',
    module: 'Suppliers & raw stock',
    label: 'Record raw stock receipts and issues',
    what:
      'Record deliveries in and issues out. A delivery is separate from the bill for it: what arrived and what they charged are kept apart, and a delivery may be billed exactly once. Un-billed deliveries are surfaced on the supplier\'s statement so nothing is quietly forgotten.',
    allows: ['Record a receipt against a supplier', 'Record an issue out of the store', 'Correct or delete a movement'],
    blocks: ['Billing the delivery, which is posting money against the supplier'],
    risk: 'normal',
    requires: ['stock.view'],
  },

  // -------------------------------------------------------------------------
  // Finished stock & packing.
  // -------------------------------------------------------------------------
  {
    key: 'finished.view',
    module: 'Finished stock & packing',
    label: 'See finished stock',
    what:
      'See what is finished and still on the floor, per product and per order. This is worked out live from the board plus adjustments, returns and bought-in goods, less what has been packed and shipped — there is no stored count that could drift.',
    allows: ['Open Finished Stock in the sidebar', 'See earmarked and free-pool quantities per product'],
    blocks: ['Adjusting the figures', 'Packing anything'],
    risk: 'normal',
  },
  {
    key: 'finished.adjust',
    module: 'Finished stock & packing',
    label: 'Adjust finished stock',
    what:
      'Record the things the board cannot know: an opening balance, a stock-count correction up or down, and goods returned by a buyer. Everything else on the floor is worked out from production, so this permission exists precisely for the exceptions — and an adjustment is the one way a finished figure can be changed by hand.',
    allows: ['Record an adjustment in or out, or a return from a buyer', 'Delete an adjustment you entered in error'],
    blocks: ['Changing what the production board says is finished'],
    risk: 'sensitive',
    requires: ['finished.view'],
  },
  {
    key: 'packing.view',
    module: 'Finished stock & packing',
    label: 'See packing batches',
    what:
      'See what has been packed into cartons: the batches, their carton counts, volumes and weights. Packing is what stands between finished and shippable — only packed goods can be dispatched.',
    allows: ['Open Packing in the sidebar and see every batch', 'See the packing queue of what is finished and awaiting cartons'],
    blocks: ['Packing anything', 'Shipping it'],
    risk: 'normal',
  },
  {
    key: 'packing.manage',
    module: 'Finished stock & packing',
    label: 'Pack goods into cartons',
    what:
      'Pack finished pieces into cartons, and correct or delete a batch. The app works out how many cartons a quantity makes and how much room and weight they take, treating a part-full carton as a whole box for volume and pro-rata for weight — because a half-full box still occupies a full box on a vessel.',
    allows: ['Create a packing batch from the queue', 'Edit or delete a batch'],
    blocks: ['Putting the cartons on a shipment'],
    risk: 'normal',
    requires: ['finished.view', 'packing.view'],
  },

  // -------------------------------------------------------------------------
  // Shipments.
  // -------------------------------------------------------------------------
  {
    key: 'shipments.view',
    module: 'Shipments',
    label: 'See shipments',
    what:
      'See dispatches and the containers that carry them, with how full each container is by volume and by weight. A shipment carries no money at all and names no buyer, because one container may be co-loaded for several buyers.',
    allows: ['Open Shipments in the sidebar', 'See any shipment, its containers, its fill and its status'],
    blocks: ['Creating or editing a shipment', 'Seeing the invoice raised against it'],
    risk: 'normal',
  },
  {
    key: 'shipments.create',
    module: 'Shipments',
    label: 'Create shipments',
    what:
      'Build a dispatch from packed cartons and assign containers. Only packed goods can be shipped, which is the whole reason the packing step exists. The container\'s capacity is checked as you load it.',
    allows: ['Create a shipment from the dispatch candidates', 'Assign containers and load packed batches'],
    blocks: ['Editing it after creation', 'Raising the invoice for it'],
    risk: 'normal',
    requires: ['packing.view', 'shipments.view'],
  },
  {
    key: 'shipments.edit',
    module: 'Shipments',
    label: 'Edit shipments',
    what:
      'Change what is on a shipment, its containers and its vessel details. Changing the load changes the container fill and the verified gross mass, both of which are worked out rather than stored, so they cannot end up contradicting the packing list.',
    allows: ['Edit a shipment\'s lines, containers and voyage details'],
    blocks: ['Changing its status', 'Deleting it'],
    risk: 'normal',
    requires: ['shipments.view'],
  },
  {
    key: 'shipments.status',
    module: 'Shipments',
    label: 'Change shipment status',
    what:
      'Advance a shipment through its stages up to dispatched. A fully shipped order becomes Shipped automatically as a result, so this moves order statuses too.',
    allows: ['Set a shipment\'s status on its page'],
    blocks: ['Editing what is on it'],
    risk: 'normal',
    requires: ['shipments.view'],
  },
  {
    key: 'shipments.documents',
    module: 'Shipments',
    label: 'Print shipping documents',
    what:
      'Download the packing list, the verified gross mass declaration, the annexure and the certificate of origin for a shipment. Every figure on them is worked out from the same shipping engine, so the documents cannot disagree with each other.',
    allows: ['Download the packing list, VGM, annexure and certificate of origin'],
    blocks: ['Changing the shipment they describe'],
    risk: 'sensitive',
    requires: ['shipments.view'],
  },
  {
    key: 'shipments.plan',
    module: 'Shipments',
    label: 'Plan container loads',
    what:
      'Use the load planner to see how packed goods would fit into containers before committing to a dispatch. A planning tool only — it creates nothing.',
    allows: ['Open the container load planner and try combinations'],
    blocks: ['Creating the shipment the plan describes'],
    risk: 'normal',
    requires: ['shipments.view'],
  },
  {
    key: 'shipments.delete',
    module: 'Shipments',
    label: 'Move shipments to trash',
    what:
      'Send a shipment to the trash. The goods return to being packed and unshipped, so an order\'s shipped quantity and possibly its status move as a result.',
    allows: ['Delete a shipment'],
    blocks: ['Deleting it permanently', 'Restoring it'],
    risk: 'destructive',
    requires: ['shipments.view'],
  },
  {
    key: 'shipments.restore',
    module: 'Shipments',
    label: 'Restore shipments from trash',
    what: 'Open the Trash drawer on the shipment list and put a deleted shipment back, with its lines and containers.',
    allows: ['Open the Trash drawer', 'Restore a deleted shipment'],
    blocks: ['Deleting permanently'],
    risk: 'normal',
    requires: ['shipments.view'],
  },
  {
    key: 'shipments.purge',
    module: 'Shipments',
    label: 'Permanently delete shipments',
    what: 'Destroy a trashed shipment for good, along with the record of what travelled in which container.',
    allows: ['Permanently delete a shipment from the Trash drawer'],
    blocks: ['Nothing — the record is gone'],
    risk: 'destructive',
    requires: ['shipments.view', 'shipments.restore'],
  },

  // -------------------------------------------------------------------------
  // Invoices — the billing document. Money-adjacent throughout.
  // -------------------------------------------------------------------------
  {
    key: 'invoices.view',
    module: 'Invoices',
    label: 'See invoices',
    what:
      'Open the invoice list and any invoice with its lines, charges, taxes and total. An invoice may span several orders of one buyer, so its total is the document\'s, not any single order\'s.',
    allows: ['Open Invoices under Finance', 'See any invoice and what it bills'],
    blocks: ['Creating, issuing or cancelling one'],
    risk: 'sensitive',
  },
  {
    key: 'invoices.create',
    module: 'Invoices',
    label: 'Raise invoices',
    what:
      'Create an invoice, from a shipment or from scratch. Raising it copies the price inputs off the order lines rather than pointing at them, so the document is frozen against a later correction to the order while still being totalled by the one pricing engine. A draft invoice is not yet a debt.',
    allows: ['Create an invoice from a shipment or by hand', 'Add freight and insurance as document charges'],
    blocks: ['Issuing it, which is what makes it owed', 'Cancelling it'],
    risk: 'sensitive',
    requires: ['invoices.view'],
  },
  {
    key: 'invoices.edit',
    module: 'Invoices',
    label: 'Edit invoices',
    what:
      'Change a draft invoice\'s lines, charges and details before it goes out. Once issued, an invoice is a document somebody has been sent, and editing it is a different matter from drafting it.',
    allows: ['Edit a draft invoice\'s lines, quantities, prices and charges'],
    blocks: ['Issuing or cancelling it'],
    risk: 'sensitive',
    requires: ['invoices.view'],
  },
  {
    key: 'invoices.issue',
    module: 'Invoices',
    label: 'Issue and cancel invoices',
    what:
      'Move an invoice from draft to issued, and cancel an issued one. Issuing is the moment it becomes a debt the buyer owes — under the invoice-based receivable setting it is exactly what appears in the receivables list. A cancelled invoice keeps its number, because a gap in an invoice series is a compliance problem, and drops out of every total.',
    allows: ['Issue a draft invoice', 'Cancel an issued invoice, keeping its number'],
    blocks: ['Editing the invoice', 'Recording what the buyer paid against it'],
    risk: 'sensitive',
    requires: ['invoices.view'],
  },
  {
    key: 'invoices.documents',
    module: 'Invoices',
    label: 'Print and e-mail invoices',
    what:
      'Download the invoice PDF and its e-mail draft, and get the payment QR code. As with the proforma, nothing is sent by the app — you press send in your own mail program.',
    allows: ['Download the invoice PDF and QR code', 'Download an e-mail draft with the invoice attached'],
    blocks: ['Changing what the invoice says'],
    risk: 'sensitive',
    requires: ['invoices.view'],
  },
  {
    key: 'invoices.delete',
    module: 'Invoices',
    label: 'Move invoices to trash',
    what:
      'Send an invoice to the trash, where it drops out of every total and can be restored. Cancelling is usually the right action for a document that was actually sent; this is for one raised in error.',
    allows: ['Delete an invoice'],
    blocks: ['Deleting it permanently', 'Restoring it'],
    risk: 'destructive',
    requires: ['invoices.view'],
  },
  {
    key: 'invoices.restore',
    module: 'Invoices',
    label: 'Restore invoices from trash',
    what: 'Open the Trash drawer on the invoice list and put a deleted invoice back, re-entering the totals it had left.',
    allows: ['Open the Trash drawer', 'Restore a deleted invoice'],
    blocks: ['Deleting permanently'],
    risk: 'normal',
    requires: ['invoices.view'],
  },
  {
    key: 'invoices.purge',
    module: 'Invoices',
    label: 'Permanently delete invoices',
    what:
      'Destroy a trashed invoice for good. Consider carefully: the number it held stays used, and a tax document that existed and was sent is usually better cancelled than erased.',
    allows: ['Permanently delete an invoice from the Trash drawer'],
    blocks: ['Nothing — the record is gone'],
    risk: 'destructive',
    requires: ['invoices.view', 'invoices.restore'],
  },

  // -------------------------------------------------------------------------
  // Money. The area where a read is as sensitive as a write.
  // -------------------------------------------------------------------------
  {
    key: 'money.view',
    module: 'Money',
    label: 'See money figures',
    what:
      'See what everybody owes and is owed: receivables per buyer, payables per supplier, vendor, worker and levy, the order value and balance on every order page, and the money figures on the front page. This is the single widest disclosure in the app — grant it as though you were handing over the ledger, because you are.',
    allows: [
      'Open Finance → Receivables and Payables',
      'See order value, amount received and balance on the order page Money tab',
      'See the money figures on the front page and the module dashboards',
      'See the unrealised currency position on multi-currency receivables',
    ],
    blocks: ['Recording any receipt or payment', 'Seeing the transaction-by-transaction statement behind a balance'],
    risk: 'sensitive',
  },
  {
    key: 'money.statements',
    module: 'Money',
    label: 'See party statements',
    what:
      'See the full running statement for a buyer, supplier, vendor, contractor or worker: every charge, every payment, how each payment was split across what was outstanding, and the closing balance. This is the detail behind the summary figures, including how much of a payment is sitting on account rather than settling anything.',
    allows: ['Open a party statement from Finance → Parties', 'See every charge and how each payment was allocated'],
    blocks: ['Recording or changing any of it'],
    risk: 'sensitive',
    requires: ['money.view'],
  },
  {
    key: 'payments.view',
    module: 'Money',
    label: 'See receipts and payments',
    what:
      'See the list of money in and money out, with what each was aimed at. Where a payment was aimed is not necessarily where it landed — payments settle the oldest debt first, and the statement shows the actual split.',
    allows: ['Open Finance → Payments and see every receipt, payment and bill'],
    blocks: ['Recording a new one', 'Deleting one'],
    risk: 'sensitive',
  },
  {
    key: 'payments.record',
    module: 'Money',
    label: 'Record receipts and payments',
    what:
      'Enter money received from buyers and paid to suppliers, vendors, contractors and workers, and bill a supplier for a delivery. Entering a payment immediately changes balances across the app, because how it settles what is outstanding is worked out fresh on every read rather than fixed at entry — a payment larger than the debt it names rolls on to the next oldest, and anything still left over becomes credit on account.',
    allows: [
      'Record a buyer receipt, in the order\'s currency',
      'Record a payment to a supplier, vendor, contractor or worker',
      'Bill a supplier delivery, once',
    ],
    blocks: [
      'Granting a worker advance, which is its own permission',
      'Paying a gang member directly — their earnings belong to their contractor',
    ],
    risk: 'sensitive',
    requires: ['payments.view'],
  },
  {
    key: 'payments.delete',
    module: 'Money',
    label: 'Move payments to trash',
    what:
      'Send a receipt or payment to the trash. Balances move the moment it goes, everywhere, because allocation is recomputed on every read. A payment that carries a worker\'s advance cash cannot be deleted on its own — the advance has to go with it.',
    allows: ['Delete a payment or receipt'],
    blocks: ['Deleting it permanently', 'Restoring it', 'Deleting advance cash without deleting the advance'],
    risk: 'destructive',
    requires: ['payments.view'],
  },
  {
    key: 'payments.restore',
    module: 'Money',
    label: 'Restore payments from trash',
    what: 'Open the Trash drawer on the payments list and put a deleted payment back, which restores its effect on every balance.',
    allows: ['Open the Trash drawer', 'Restore a deleted payment'],
    blocks: ['Deleting permanently'],
    risk: 'normal',
    requires: ['payments.view'],
  },
  {
    key: 'payments.purge',
    module: 'Money',
    label: 'Permanently delete payments',
    what: 'Destroy a trashed payment for good. The money it recorded is gone from the books with no way back.',
    allows: ['Permanently delete a payment from the Trash drawer'],
    blocks: ['Nothing — the record is gone'],
    risk: 'destructive',
    requires: ['payments.view', 'payments.restore'],
  },

  // -------------------------------------------------------------------------
  // Manforce. Note the deliberate split of identity from everything else.
  // -------------------------------------------------------------------------
  {
    key: 'workers.view',
    module: 'Manforce',
    label: 'See workers',
    what:
      'See the worker list and worker pages: name, trade, pay type, whether they are in a contractor\'s gang, and their attendance. Identity documents and bank details are held back unless you also have permission to see them.',
    allows: ['Open Manforce → Workers and open any worker'],
    blocks: ['Seeing identity or bank details', 'Seeing what they have earned or are owed', 'Editing anything'],
    risk: 'normal',
  },
  {
    key: 'workers.pii',
    module: 'Manforce',
    label: 'See worker identity and bank details',
    what:
      'See the personal information held against a worker — identity document numbers, addresses and bank account details. Without this permission these fields are removed from the data before it leaves the server, not merely hidden on screen, so there is no way to reach them from a browser.',
    allows: ['See identity and bank fields on a worker page', 'See them on the worker form when editing'],
    blocks: ['Changing them'],
    risk: 'sensitive',
    requires: ['workers.view'],
  },
  {
    key: 'workers.manage',
    module: 'Manforce',
    label: 'Add and edit workers',
    what:
      'Create workers and edit their details, including trade, pay type and contractor. One field deserves care: the date from which earnings start accruing exists so that a worker migrated from hand-written records is not paid twice for history, and setting it to their joining date would do exactly that.',
    allows: ['Create a worker', 'Edit trade, pay type, contractor and the accrual start date', 'Deactivate or delete a worker'],
    blocks: ['Setting their pay rate', 'Marking attendance', 'Paying them'],
    risk: 'sensitive',
    requires: ['workers.view'],
  },
  {
    key: 'workers.rates',
    module: 'Manforce',
    label: 'Set worker pay rates',
    what:
      'Set what a worker is paid and on what basis — a day rate, a monthly salary spread across working days, or piece rates taken from the production board. This is the number every earning is calculated from, so it is kept separate from ordinary worker details.',
    allows: ['Set a worker\'s pay type and rate'],
    blocks: ['Paying them', 'Seeing their balance'],
    risk: 'sensitive',
    requires: ['workers.view', 'workers.manage'],
  },
  {
    key: 'workers.documents',
    module: 'Manforce',
    label: 'Upload worker documents',
    what:
      'Upload photographs and identity documents against a worker and remove them. Deleting a worker removes their files from disk as well as their rows, so nothing is left orphaned.',
    allows: ['Upload a worker photo or document', 'Delete one'],
    blocks: ['Seeing the identity numbers typed into the worker\'s fields, which is a separate permission'],
    risk: 'sensitive',
    requires: ['workers.view'],
  },
  {
    key: 'muster.view',
    module: 'Manforce',
    label: 'See the muster',
    what:
      'See attendance. Every active worker is presumed present on a working day and a row exists only to say otherwise, so the muster is a list of exceptions rather than a register of everybody.',
    allows: ['Open Manforce → Muster and see attendance by day and by worker'],
    blocks: ['Marking or changing attendance'],
    risk: 'normal',
    requires: ['workers.view'],
  },
  {
    key: 'muster.mark',
    module: 'Manforce',
    label: 'Mark the muster',
    what:
      'Record absences, half days and days worked on a day off. Because day-rate and monthly wages are worked out from the calendar, marking somebody absent reduces what they earn — this is a money action wearing everyday clothes.',
    allows: ['Mark absence, part attendance or a paid day off for any worker'],
    blocks: ['Setting rates', 'Paying anybody', 'Changing which days count as working days'],
    risk: 'sensitive',
    requires: ['workers.view', 'muster.view'],
  },
  {
    key: 'wages.view',
    module: 'Manforce',
    label: 'See wages and worker balances',
    what:
      'See what each worker has earned, what has been deducted, what has been paid and what is left — and the same for contractors, whose gang members\' earnings roll up into their balance. A worker is a running account, not a pay period: there is nothing to run and nothing to close.',
    allows: ['Open Manforce → Wages', 'See a worker\'s earnings, deductions, payments and balance'],
    blocks: ['Paying anybody', 'Changing a rate', 'Granting an advance'],
    risk: 'sensitive',
    requires: ['workers.view'],
  },
  {
    key: 'advances.manage',
    module: 'Manforce',
    label: 'Grant and cancel worker advances',
    what:
      'Give a worker money in advance and set how it is recovered from later earnings, up to a monthly cap. The cash and the recovery terms are one thing: deleting the payment on its own is refused, and deleting the advance takes the cash with it.',
    allows: ['Grant an advance with recovery terms', 'Cancel an advance, which removes the cash paid with it'],
    blocks: ['Ordinary wage payments'],
    risk: 'sensitive',
    requires: ['workers.view', 'wages.view'],
  },
  {
    key: 'deductions.manage',
    module: 'Manforce',
    label: 'Record worker deductions',
    what: 'Record deductions against a worker — damages, canteen, anything agreed — and remove them. Each one reduces the balance owed to that worker.',
    allows: ['Add and remove deductions on a worker'],
    blocks: ['Statutory deductions, which are posted separately'],
    risk: 'sensitive',
    requires: ['workers.view', 'wages.view'],
  },
  {
    key: 'statutory.view',
    module: 'Manforce',
    label: 'See statutory postings',
    what:
      'See the statutory liabilities that have been posted — provident fund, insurance and anything else configured — and preview what a period would come to before it is posted.',
    allows: ['Open Manforce → Statutory and see past postings', 'Preview a period'],
    blocks: ['Posting a period', 'Deleting a posting'],
    risk: 'sensitive',
    requires: ['workers.view'],
  },
  {
    key: 'statutory.post',
    module: 'Manforce',
    label: 'Post statutory liabilities',
    what:
      'Post a statutory period, which incurs the liability. The wage base used is stored with the posting on purpose: the earnings behind it can legitimately be restated later — by a holiday being added, say — and a liability that was already posted must not move afterwards. Overlapping periods for one component are refused.',
    allows: ['Post a statutory period for a component', 'Delete a posting'],
    blocks: ['Changing which components exist or their rates'],
    risk: 'sensitive',
    requires: ['workers.view', 'statutory.view'],
  },
  {
    key: 'contractors.manage',
    module: 'Manforce',
    label: 'Manage contractors',
    what:
      'Create and edit labour contractors. A worker placed under a contractor stops being a payable in their own right — their earnings roll into the contractor\'s balance and paying them directly is refused, so the money cannot be counted twice.',
    allows: ['Create and edit contractors', 'Delete an unused one'],
    blocks: ['Paying a contractor', 'Assigning workers to them, which is done on the worker'],
    risk: 'normal',
    requires: ['workers.view'],
  },

  // -------------------------------------------------------------------------
  // Products. Costing is split out because it is the factory's margin.
  // -------------------------------------------------------------------------
  {
    key: 'products.view',
    module: 'Products',
    label: 'See products',
    what:
      'Open the product list, the catalogue and any product page: photos, dimensions, attributes, packing figures and which stage route it follows. The cost sheet and the resulting price are held back separately.',
    allows: ['Open Products in the sidebar', 'See specifications, photos and packing details'],
    blocks: ['Seeing costings or the FOB price', 'Editing anything'],
    risk: 'normal',
  },
  {
    key: 'products.costing.view',
    module: 'Products',
    label: 'See product costings',
    what:
      'See the cost sheet behind a product: every material, hardware, polishing, packaging, labour and forwarding line with its rate, and the roll-up to ex-factory and FOB. This is the factory\'s cost base and its margin — the most commercially sensitive information in the product module.',
    allows: ['See the full cost sheet, its groups and line rates', 'See ex-factory, FOB and non-FOB figures'],
    blocks: ['Changing a rate', 'Seeing what the product has actually been sold for'],
    risk: 'sensitive',
    requires: ['products.view'],
  },
  {
    key: 'products.create',
    module: 'Products',
    label: 'Create products',
    what: 'Add a new product through the wizard: specification, dimensions, attributes, packing, stage route and cost sheet.',
    allows: ['Use New Product and complete the wizard, including its costing'],
    blocks: ['Editing a product afterwards'],
    risk: 'normal',
    requires: ['products.view'],
  },
  {
    key: 'products.edit',
    module: 'Products',
    label: 'Edit products',
    what:
      'Change a product\'s specification, dimensions, attributes, packing figures and stage route. Packing figures reach further than they look: the volume per piece is what every container load is worked out from.',
    allows: ['Edit any non-costing field on a product', 'Change its stage route and packing figures'],
    blocks: ['Changing cost sheet rates, which is Edit product costings'],
    risk: 'normal',
    requires: ['products.view'],
  },
  {
    key: 'products.costing.edit',
    module: 'Products',
    label: 'Edit product costings',
    what:
      'Change the rates on a product\'s cost sheet, which changes its ex-factory and FOB price. Every rate change is recorded against the product with its old value and author, because saving a product replaces the whole sheet and the previous rates would otherwise be gone. Existing orders are unaffected — they carry the prices agreed at the time.',
    allows: ['Add, remove and re-rate cost lines and groups', 'Change wastage, factory expense and margin percentages'],
    blocks: ['Changing the formulas the measures are calculated by, which is master data'],
    risk: 'sensitive',
    requires: ['products.view', 'products.costing.view'],
  },
  {
    key: 'products.photos',
    module: 'Products',
    label: 'Manage product photos',
    what:
      'Upload product photographs, remove them and choose the primary one. The primary photo is what appears on a proforma PDF in front of the buyer. Uploads are checked by their actual contents rather than their filename.',
    allows: ['Upload and delete product images', 'Set the primary image'],
    blocks: ['Editing any other product field'],
    risk: 'normal',
    requires: ['products.view'],
  },
  {
    key: 'products.history',
    module: 'Products',
    label: 'See product rate history',
    what:
      'See the History tab on a product: every change to a cost line rate or a percentage, with the old value, the new value, who made it and when.',
    allows: ['Open a product\'s History tab'],
    blocks: ['Changing or removing an entry'],
    risk: 'sensitive',
    requires: ['products.view'],
  },
  {
    key: 'products.delete',
    module: 'Products',
    label: 'Move products to trash',
    what:
      'Send a product to the trash. Orders that reference it are unaffected — they keep their own copies of what was agreed — so the app warns that it is in use rather than refusing.',
    allows: ['Delete a product'],
    blocks: ['Deleting it permanently', 'Restoring it'],
    risk: 'destructive',
    requires: ['products.view'],
  },
  {
    key: 'products.restore',
    module: 'Products',
    label: 'Restore products from trash',
    what: 'Open the Trash drawer on the product list and put a deleted product back.',
    allows: ['Open the Trash drawer', 'Restore a deleted product'],
    blocks: ['Deleting permanently'],
    risk: 'normal',
    requires: ['products.view'],
  },
  {
    key: 'products.purge',
    module: 'Products',
    label: 'Permanently delete products',
    what:
      'Destroy a trashed product for good, with its cost sheet and photos. Unlike the safe delete, this is refused outright if anything still references the product, because the links really would break.',
    allows: ['Permanently delete an unreferenced product from the Trash drawer'],
    blocks: ['Deleting a product that any order, proforma or sheet still refers to'],
    risk: 'destructive',
    requires: ['products.view', 'products.restore'],
  },

  // -------------------------------------------------------------------------
  // Master data. Small screens, long reach.
  // -------------------------------------------------------------------------
  {
    key: 'masters.view',
    module: 'Master data',
    label: 'See master data',
    what:
      'Open the Master Data screens read-only: currencies, units, attributes, stage routes, cost formulas, container types and company details. Almost every other screen depends on these, so seeing them is often needed to make sense of what is elsewhere.',
    allows: ['Open Master Data and read every tab'],
    blocks: ['Changing anything'],
    risk: 'normal',
  },
  {
    key: 'buyers.view',
    module: 'Master data',
    label: 'See buyers',
    what:
      'See the buyer list and buyer details, including whether each is overseas or domestic and business or retail — the two settings that decide how their documents are priced, taxed, numbered and titled.',
    allows: ['Open the buyer list and see contact, market, channel and tax details'],
    blocks: ['Adding or editing a buyer', 'Seeing what they owe'],
    risk: 'normal',
  },
  {
    key: 'buyers.manage',
    module: 'Master data',
    label: 'Add and edit buyers',
    what:
      'Create buyers and edit their details. Two fields change arithmetic rather than just records: the market decides FOB-in-currency versus rupees-with-GST, and the state decides whether tax splits into CGST and SGST or is charged as IGST. A domestic buyer without a state is refused, because the split would otherwise be silently wrong.',
    allows: ['Create a buyer', 'Set market, channel, currency, state and tax registration', 'Deactivate or delete an unused buyer'],
    blocks: ['Changing an existing order or proforma to match', 'Seeing their balance'],
    risk: 'sensitive',
    requires: ['buyers.view'],
  },
  {
    key: 'currencies.manage',
    module: 'Master data',
    label: 'Manage currencies',
    what:
      'Add currencies and set their rate against the rupee. The live rate is what today\'s value of an outstanding order is worked out from, so changing it moves the reported currency position — though not what any order was booked at, which is captured when the order is created.',
    allows: ['Add and edit currencies', 'Set a rate by hand', 'Deactivate or delete an unused currency'],
    blocks: ['Changing the rate an existing order was booked at'],
    risk: 'sensitive',
    requires: ['masters.view'],
  },
  {
    key: 'currencies.rates.import',
    module: 'Master data',
    label: 'Import customs exchange rates',
    what:
      'Paste the customs exchange-rate table and have the export column applied to every currency at once. The customs site is protected by a puzzle that a person has to solve, so the rates are fetched by hand and pasted in — this permission covers applying them, not visiting the site.',
    allows: ['Paste the customs rate table and apply it to all currencies in one go'],
    blocks: ['Editing an individual currency\'s other details'],
    risk: 'sensitive',
    requires: ['masters.view', 'currencies.manage'],
  },
  {
    key: 'units.manage',
    module: 'Master data',
    label: 'Manage units',
    what: 'Add and edit the units of measure used across products, raw items and costing.',
    allows: ['Add, edit, deactivate and delete units'],
    blocks: ['Nothing else — units are referenced everywhere but change nothing on their own'],
    risk: 'normal',
    requires: ['masters.view'],
  },
  {
    key: 'attributes.manage',
    module: 'Master data',
    label: 'Manage product attributes',
    what: 'Define the attributes products can carry and their permitted values — finish, timber, hardware type and so on.',
    allows: ['Add, edit and delete attributes and their values'],
    blocks: ['Setting them on a product'],
    risk: 'normal',
    requires: ['masters.view'],
  },
  {
    key: 'stagelines.manage',
    module: 'Master data',
    label: 'Manage stage routes',
    what:
      'Define the named production routes — the ordered stages a product passes through — and each stage\'s typical duration, which is what makes automatic scheduling believable. Editing a route never rewrites live orders: each order takes its own copy of the stages when it is created.',
    allows: ['Create and edit stage routes, their steps, order and default durations'],
    blocks: ['Changing the route of an order already in production'],
    risk: 'normal',
    requires: ['masters.view'],
  },
  {
    key: 'costmethods.manage',
    module: 'Master data',
    label: 'Manage cost formulas',
    what:
      'Create and edit the formulas that turn a product\'s dimensions into a measured quantity — cubic feet, square feet, running feet, weight and any others you write. These are the arithmetic behind every cost sheet in the app, so an edit here changes what many products cost at once. The most far-reaching permission in master data.',
    allows: ['Create, edit and delete cost formulas and their expressions'],
    blocks: ['Changing a product\'s rates'],
    risk: 'destructive',
    requires: ['masters.view'],
  },
  {
    key: 'containertypes.manage',
    module: 'Master data',
    label: 'Manage container types',
    what:
      'Define container types and their volume and payload limits. These limits are what every load is checked against, so raising one lets more be loaded onto the same box. A type with no capacity means a part load and is never reported as over capacity.',
    allows: ['Add and edit container types, their volume and their payload'],
    blocks: ['Assigning a container to a shipment'],
    risk: 'sensitive',
    requires: ['masters.view'],
  },
  {
    key: 'company.manage',
    module: 'Master data',
    label: 'Manage company details',
    what:
      'Edit the company record and its logo — the letterhead on every document. The state matters beyond appearance: it is compared with the buyer\'s to decide whether domestic tax splits into CGST and SGST or is charged as IGST, and an unset state charges IGST rather than silently under-collecting.',
    allows: ['Edit company name, address, state, tax registrations and bank details', 'Upload or replace the logo'],
    blocks: ['Changing the tax already snapshotted onto existing orders'],
    risk: 'sensitive',
    requires: ['masters.view'],
  },
  {
    key: 'trades.manage',
    module: 'Master data',
    label: 'Manage trades',
    what: 'Define the trades workers can belong to — carpenter, polisher, packer and so on.',
    allows: ['Add, edit, reorder and delete trades'],
    blocks: ['Assigning a trade to a worker'],
    risk: 'normal',
    requires: ['masters.view'],
  },
  {
    key: 'holidays.manage',
    module: 'Master data',
    label: 'Manage holidays and working days',
    what:
      'Set the weekly days off and the holiday calendar. This restates wages that have already accrued, on purpose — adding a holiday after the fact corrects what day-rate and monthly workers earned for that period, which is the whole reason those figures are worked out rather than stored.',
    allows: ['Add and remove holidays', 'Set which weekdays are off'],
    blocks: ['Changing a statutory posting that has already been made'],
    risk: 'sensitive',
    requires: ['masters.view'],
  },
  {
    key: 'workforce.settings',
    module: 'Master data',
    label: 'Manage workforce settings',
    what:
      'Set how monthly salaries are divided into a daily figure and whether workers are presumed present unless marked absent. Both change what every day-rate and monthly worker has earned across the whole history.',
    allows: ['Set the monthly divisor basis and the presumed-present rule'],
    blocks: ['Marking attendance', 'Setting an individual worker\'s rate'],
    risk: 'sensitive',
    requires: ['masters.view'],
  },
  {
    key: 'statutory.components.manage',
    module: 'Master data',
    label: 'Manage statutory components',
    what:
      'Define the statutory levies that can be posted, their rates and whether each is a real payable or only a provision. Rates here decide what future postings come to; postings already made keep the wage base they used and do not move.',
    allows: ['Create, edit and delete statutory components and their rates'],
    blocks: ['Posting a period', 'Changing a posting already made'],
    risk: 'sensitive',
    requires: ['masters.view'],
  },

  // -------------------------------------------------------------------------
  // Settings & users. The permission that guards permissions lives here.
  // -------------------------------------------------------------------------
  {
    key: 'suggestions.view',
    module: 'Settings & users',
    label: 'See past-figure suggestions',
    what:
      'See what a rate or price was last time, beside the field you are typing into — what this line was costed at in other products, what suppliers actually billed, what vendors charged and workers earned for a stage, and what buyers have paid. These come from the live records on every request, so a correction to the original shows up immediately. It is a broad disclosure of commercial figures in a small box.',
    allows: ['See suggestions and the unusual-figure note beside cost, rate and price fields'],
    blocks: ['Changing the period suggestions are drawn from'],
    risk: 'sensitive',
  },
  {
    key: 'settings.app',
    module: 'Settings & users',
    label: 'Change application settings',
    what:
      'Change how the app itself behaves — most consequentially whether a buyer owes you from the order or only from the issued invoice. Flipping that restates every balance and every statement in the app the moment it is saved, with no migration and nothing to rebuild, because balances are worked out on every read. Also sets how far back suggestions look.',
    allows: ['Switch the receivable basis between order and invoice', 'Set the suggestion window'],
    blocks: ['Changing any individual figure'],
    risk: 'destructive',
    requires: ['masters.view'],
  },
  {
    key: 'changelog.view',
    module: 'Settings & users',
    label: 'See any record\'s change history',
    what:
      'See the log of price and rate changes for ANY record, including the ones with no History tab of their own — raw items, statutory components, contractors. This is the superset of the per-record history permissions: somebody who holds it does not also need the product or order ones. Only money and rates are recorded; a log of every keystroke would bury the entry anybody needs.',
    allows: ['See the change history of any record type', 'Cover record types that have no History tab'],
    blocks: ['Changing or removing an entry — the log is append-only for everyone'],
    risk: 'sensitive',
  },
  {
    key: 'users.view',
    module: 'Settings & users',
    label: 'See users',
    what: 'See the list of logins, who holds which role, and which accounts are active.',
    allows: ['Open Settings → Users and see every account and its role'],
    blocks: ['Creating a user', 'Changing a password', 'Changing what a role can do'],
    risk: 'sensitive',
  },
  {
    key: 'users.manage',
    module: 'Settings & users',
    label: 'Add and edit users',
    what:
      'Create logins, set and reset passwords, assign roles, and deactivate accounts. Assigning a role hands over exactly what that role can do, so this permission is as strong as the strongest role in the system. An account that has done work is deactivated rather than deleted, so the record of who made what survives.',
    allows: ['Create a user and set their password', 'Assign or change a user\'s role', 'Deactivate or delete an account'],
    blocks: [
      'Changing what a role can do — that is Manage roles',
      'Deactivating or demoting the last remaining owner',
      'Deleting the account you are signed in with',
    ],
    risk: 'destructive',
    requires: ['users.view'],
  },
  {
    key: 'roles.view',
    module: 'Settings & users',
    label: 'See roles and permissions',
    what: 'See the roles that exist, what each one is allowed to do, and how many people hold it. Read-only.',
    allows: ['Open Settings → Roles and inspect every role\'s permissions'],
    blocks: ['Changing a role', 'Assigning one to anybody'],
    risk: 'sensitive',
  },
  {
    key: 'roles.manage',
    module: 'Settings & users',
    label: 'Create and change roles',
    what:
      'Create roles, rename them and decide exactly what each one may do. This is the permission that governs permissions: anybody who holds it can grant themselves anything else in this catalogue, so it is effectively full control of the application and should sit with one or two people. Two things are refused to stop the app being locked shut — you cannot remove this permission from your own role, and a role somebody still holds cannot be deleted until they are moved off it.',
    allows: ['Create, rename and delete roles', 'Grant and revoke any permission in this catalogue'],
    blocks: [
      'Removing this permission from your own role',
      'Deleting a role that users still hold',
      'Removing owner status from the last active owner',
    ],
    risk: 'destructive',
    requires: ['roles.view'],
  },
];

/** Every key, for validation and for the "grant everything" case. */
export const PERMISSION_KEYS: readonly string[] = PERMISSIONS.map((p) => p.key);

const BY_KEY = new Map(PERMISSIONS.map((p) => [p.key, p]));

export function permissionDef(key: string): PermissionDef | undefined {
  return BY_KEY.get(key);
}

export function isPermissionKey(key: string): boolean {
  return BY_KEY.has(key);
}

/**
 * Close a set of granted keys over `requires`, so a role holding `orders.edit` also holds
 * `orders.view`. Applied when a role is SAVED rather than when it is checked: a permission
 * check must be a plain set membership test, or enforcement would depend on the shape of
 * this file and a route's stated requirements would stop being the whole truth.
 */
export function withRequired(keys: Iterable<string>): string[] {
  const out = new Set<string>();
  const walk = (key: string) => {
    if (out.has(key)) return;
    const def = BY_KEY.get(key);
    if (!def) return; // unknown keys are dropped, not carried into the database
    out.add(key);
    for (const req of def.requires ?? []) walk(req);
  };
  for (const key of keys) walk(key);
  return [...out];
}

/** Grouped for the Roles screen, in `PERMISSION_MODULES` order. */
export function permissionsByModule(): { module: string; permissions: PermissionDef[] }[] {
  return PERMISSION_MODULES.map((module) => ({
    module,
    permissions: PERMISSIONS.filter((p) => p.module === module),
  })).filter((g) => g.permissions.length > 0);
}
