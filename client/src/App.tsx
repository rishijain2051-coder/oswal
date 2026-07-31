import { Link, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { Button, Result, Spin } from 'antd';
import { useAuth } from './auth/AuthContext';
import AppLayout from './components/AppLayout';
import LoginPage from './pages/LoginPage';
import HomePage from './pages/HomePage';
import ProductModuleHome from './pages/product/ProductModuleHome';
import ProductCataloguePage from './pages/product/ProductCataloguePage';
import ProductListPage from './pages/product/ProductListPage';
import ProductDetailPage from './pages/product/ProductDetailPage';
import ProductWizardPage from './pages/product/ProductWizardPage';
import MastersPage from './pages/settings/MastersPage';
import UsersPage from './pages/settings/UsersPage';
import RolesPage from './pages/settings/RolesPage';
import OperationsHome from './pages/operations/OperationsHome';
import OrdersPage from './pages/operations/OrdersPage';
import OrderEditPage from './pages/operations/OrderEditPage';
import OrderDetailPage from './pages/operations/OrderDetailPage';
import ProformasPage from './pages/operations/ProformasPage';
import ProformaEditPage from './pages/operations/ProformaEditPage';
import ProformaDetailPage from './pages/operations/ProformaDetailPage';
import SuppliersPage from './pages/operations/SuppliersPage';
import StockPage from './pages/operations/StockPage';
import DeliveryTracker from './pages/operations/DeliveryTracker';
import SheetsPage from './pages/operations/SheetsPage';
import SheetDetailPage from './pages/operations/SheetDetailPage';
import FinanceHome from './pages/finance/FinanceHome';
import PaymentsPage from './pages/finance/PaymentsPage';
import PartyStatementPage from './pages/finance/PartyStatementPage';
import InvoicesPage from './pages/finance/InvoicesPage';
import InvoiceDetailPage from './pages/finance/InvoiceDetailPage';
import ManforceHome from './pages/manforce/ManforceHome';
import WorkersPage from './pages/manforce/WorkersPage';
import WorkerDetailPage from './pages/manforce/WorkerDetailPage';
import MusterPage from './pages/manforce/MusterPage';
import WagesPage from './pages/manforce/WagesPage';
import StatutoryPage from './pages/manforce/StatutoryPage';
import SalesHome from './pages/sales/SalesHome';
import FinishedStockPage from './pages/sales/FinishedStockPage';
import PackingPage from './pages/sales/PackingPage';
import ShipmentsPage from './pages/sales/ShipmentsPage';
import ShipmentEditPage from './pages/sales/ShipmentEditPage';
import ShipmentDetailPage from './pages/sales/ShipmentDetailPage';

/**
 * A page that moved, keeping whatever came after the prefix.
 *
 * `/operations/payments/buyer/3` has to land on `/finance/payments/buyer/3`, so the
 * splat is carried across rather than dropping the visitor on the section index.
 */
function MovedTo({ to }: { to: string }) {
  const rest = useParams()['*'];
  return <Navigate to={rest ? `${to}/${rest}` : to} replace />;
}

function RequireAuth({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
        <Spin size="large" />
      </div>
    );
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

/**
 * A page somebody has no permission to open.
 *
 * The router had no permission checks at all, which was survivable while every page also
 * checked for itself — but a role can now be missing any single permission, so a user
 * following an old link would land on a screen that rendered empty and then failed a dozen
 * requests. Saying so once, in words that name the permission, is better than a page full of
 * error toasts. This is a courtesy, not a safeguard: the server refuses the calls regardless.
 */
function NoAccess({ what }: { what: string }) {
  return (
    <Result
      status="403"
      title="You do not have access to this"
      subTitle={`Opening ${what} needs a permission your role does not have. Ask whoever manages roles for it.`}
      extra={
        <Link to="/">
          <Button type="primary">Back to the front page</Button>
        </Link>
      }
    />
  );
}

/** Gate a route on every listed permission. */
function Needs({ keys, what, children }: { keys: string[]; what: string; children: JSX.Element }) {
  const { can } = useAuth();
  return can(...keys) ? children : <NoAccess what={what} />;
}

/** Gate a route on at least one of the listed permissions — for a page two jobs reach. */
function NeedsAny({ keys, what, children }: { keys: string[]; what: string; children: JSX.Element }) {
  const { canAny } = useAuth();
  return canAny(...keys) ? children : <NoAccess what={what} />;
}

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<HomePage />} />

        {/* Product Management (Phase 1) */}
        <Route path="products" element={<Needs keys={['products.view']} what="products"><ProductModuleHome /></Needs>} />
        <Route path="products/catalogue" element={<Needs keys={['products.view']} what="the catalogue"><ProductCataloguePage /></Needs>} />
        <Route path="products/catalogue/:id" element={<Needs keys={['products.view']} what="a product"><ProductDetailPage catalogueMode /></Needs>} />
        <Route path="products/list" element={<Needs keys={['products.view']} what="products"><ProductListPage /></Needs>} />
        <Route path="products/new" element={<Needs keys={['products.create']} what="the new-product wizard"><ProductWizardPage /></Needs>} />
        <Route path="products/:id" element={<Needs keys={['products.view']} what="a product"><ProductDetailPage /></Needs>} />
        <Route path="products/:id/edit" element={<Needs keys={['products.edit']} what="the product editor"><ProductWizardPage /></Needs>} />

        {/* Settings */}
        <Route path="settings/masters" element={<Needs keys={['masters.view']} what="master data"><MastersPage /></Needs>} />
        <Route path="settings/users" element={<Needs keys={['users.view']} what="users"><UsersPage /></Needs>} />
        <Route path="settings/roles" element={<Needs keys={['roles.view']} what="roles and permissions"><RolesPage /></Needs>} />

        {/* Operations (Phase 2) */}
        <Route path="operations" element={<NeedsAny keys={['orders.view', 'proformas.view', 'sheets.view', 'stock.view', 'suppliers.view']} what="Operations"><OperationsHome /></NeedsAny>} />
        <Route path="operations/orders" element={<Needs keys={['orders.view']} what="orders"><OrdersPage /></Needs>} />
        <Route path="operations/orders/new" element={<Needs keys={['orders.create']} what="the new-order form"><OrderEditPage /></Needs>} />
        <Route path="operations/orders/:id" element={<Needs keys={['orders.view']} what="an order"><OrderDetailPage /></Needs>} />
        <Route path="operations/orders/:id/edit" element={<Needs keys={['orders.edit']} what="the order editor"><OrderEditPage /></Needs>} />
        <Route path="operations/proformas" element={<Needs keys={['proformas.view']} what="proformas"><ProformasPage /></Needs>} />
        <Route path="operations/proformas/new" element={<Needs keys={['proformas.create']} what="the new-proforma form"><ProformaEditPage /></Needs>} />
        <Route path="operations/proformas/:id" element={<Needs keys={['proformas.view']} what="a proforma"><ProformaDetailPage /></Needs>} />
        <Route path="operations/proformas/:id/edit" element={<Needs keys={['proformas.edit']} what="the proforma editor"><ProformaEditPage /></Needs>} />
        <Route path="operations/suppliers" element={<Needs keys={['suppliers.view']} what="suppliers"><SuppliersPage /></Needs>} />
        <Route path="operations/stock" element={<Needs keys={['stock.view']} what="raw stock"><StockPage /></Needs>} />
        <Route path="operations/delivery" element={<Needs keys={['orders.view', 'orders.schedule.view']} what="delivery tracking"><DeliveryTracker /></Needs>} />
        <Route path="operations/sheets" element={<Needs keys={['sheets.view']} what="material sheets"><SheetsPage /></Needs>} />
        <Route path="operations/sheets/:id" element={<Needs keys={['sheets.view']} what="a material sheet"><SheetDetailPage /></Needs>} />

        {/* Manforce (Phase 3) */}
        <Route path="manforce" element={<NeedsAny keys={['workers.view', 'wages.view']} what="Manforce"><ManforceHome /></NeedsAny>} />
        <Route path="manforce/workers" element={<Needs keys={['workers.view']} what="workers"><WorkersPage /></Needs>} />
        <Route path="manforce/workers/:id" element={<Needs keys={['workers.view']} what="a worker"><WorkerDetailPage /></Needs>} />
        <Route path="manforce/muster" element={<Needs keys={['workers.view', 'muster.view']} what="the muster"><MusterPage /></Needs>} />
        <Route path="manforce/wages" element={<Needs keys={['workers.view', 'wages.view']} what="wages"><WagesPage /></Needs>} />
        <Route path="manforce/statutory" element={<Needs keys={['workers.view', 'statutory.view']} what="statutory postings"><StatutoryPage /></Needs>} />

        {/* Dispatch (Phase 4) — the physical half. The money half is under /finance. */}
        <Route path="sales" element={<NeedsAny keys={['finished.view', 'packing.view', 'shipments.view']} what="Dispatch"><SalesHome /></NeedsAny>} />
        <Route path="sales/stock" element={<Needs keys={['finished.view']} what="finished stock"><FinishedStockPage /></Needs>} />
        <Route path="sales/packing" element={<Needs keys={['packing.view']} what="packing"><PackingPage /></Needs>} />
        <Route path="sales/shipments" element={<Needs keys={['shipments.view']} what="shipments"><ShipmentsPage /></Needs>} />
        <Route path="sales/shipments/new" element={<Needs keys={['shipments.create']} what="the new-shipment form"><ShipmentEditPage /></Needs>} />
        <Route path="sales/shipments/:id" element={<Needs keys={['shipments.view']} what="a shipment"><ShipmentDetailPage /></Needs>} />
        <Route path="sales/shipments/:id/edit" element={<Needs keys={['shipments.edit']} what="the shipment editor"><ShipmentEditPage /></Needs>} />

        {/* Finance — everything with money on it, whichever module produced it. Payments used
            to live under Operations and invoices under Sales, which meant the two halves of
            one buyer's position were on opposite sides of the menu. */}
        <Route path="finance" element={<NeedsAny keys={['money.view', 'payments.view', 'invoices.view']} what="Finance"><FinanceHome /></NeedsAny>} />
        <Route path="finance/payments" element={<Needs keys={['payments.view']} what="receipts and payments"><PaymentsPage /></Needs>} />
        <Route path="finance/payments/:partyType/:partyId" element={<Needs keys={['money.view', 'money.statements']} what="a party statement"><PartyStatementPage /></Needs>} />
        <Route path="finance/invoices" element={<Needs keys={['invoices.view']} what="invoices"><InvoicesPage /></Needs>} />
        {/* No `invoices/new`: an invoice is raised from its shipment, because its money is
            derived from what shipped. The same reason an order only comes from a proforma. */}
        <Route path="finance/invoices/:id" element={<Needs keys={['invoices.view']} what="an invoice"><InvoiceDetailPage /></Needs>} />

        {/* The money pages moved. A bookmark or a pasted link must still land, and
            `*` after the prefix carries the party type and id or the invoice id with it. */}
        <Route path="operations/payments/*" element={<MovedTo to="/finance/payments" />} />
        <Route path="sales/invoices/*" element={<MovedTo to="/finance/invoices" />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
