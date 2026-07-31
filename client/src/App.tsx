import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { Spin } from 'antd';
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
        <Route path="products" element={<ProductModuleHome />} />
        <Route path="products/catalogue" element={<ProductCataloguePage />} />
        <Route path="products/catalogue/:id" element={<ProductDetailPage catalogueMode />} />
        <Route path="products/list" element={<ProductListPage />} />
        <Route path="products/new" element={<ProductWizardPage />} />
        <Route path="products/:id" element={<ProductDetailPage />} />
        <Route path="products/:id/edit" element={<ProductWizardPage />} />

        {/* Settings */}
        <Route path="settings/masters" element={<MastersPage />} />
        <Route path="settings/users" element={<UsersPage />} />

        {/* Operations (Phase 2) */}
        <Route path="operations" element={<OperationsHome />} />
        <Route path="operations/orders" element={<OrdersPage />} />
        <Route path="operations/orders/new" element={<OrderEditPage />} />
        <Route path="operations/orders/:id" element={<OrderDetailPage />} />
        <Route path="operations/orders/:id/edit" element={<OrderEditPage />} />
        <Route path="operations/proformas" element={<ProformasPage />} />
        <Route path="operations/proformas/new" element={<ProformaEditPage />} />
        <Route path="operations/proformas/:id" element={<ProformaDetailPage />} />
        <Route path="operations/proformas/:id/edit" element={<ProformaEditPage />} />
        <Route path="operations/suppliers" element={<SuppliersPage />} />
        <Route path="operations/stock" element={<StockPage />} />
        <Route path="operations/delivery" element={<DeliveryTracker />} />
        <Route path="operations/sheets" element={<SheetsPage />} />
        <Route path="operations/sheets/:id" element={<SheetDetailPage />} />

        {/* Manforce (Phase 3) */}
        <Route path="manforce" element={<ManforceHome />} />
        <Route path="manforce/workers" element={<WorkersPage />} />
        <Route path="manforce/workers/:id" element={<WorkerDetailPage />} />
        <Route path="manforce/muster" element={<MusterPage />} />
        <Route path="manforce/wages" element={<WagesPage />} />
        <Route path="manforce/statutory" element={<StatutoryPage />} />

        {/* Dispatch (Phase 4) — the physical half. The money half is under /finance. */}
        <Route path="sales" element={<SalesHome />} />
        <Route path="sales/stock" element={<FinishedStockPage />} />
        <Route path="sales/packing" element={<PackingPage />} />
        <Route path="sales/shipments" element={<ShipmentsPage />} />
        <Route path="sales/shipments/new" element={<ShipmentEditPage />} />
        <Route path="sales/shipments/:id" element={<ShipmentDetailPage />} />
        <Route path="sales/shipments/:id/edit" element={<ShipmentEditPage />} />

        {/* Finance — everything with money on it, whichever module produced it. Payments used
            to live under Operations and invoices under Sales, which meant the two halves of
            one buyer's position were on opposite sides of the menu. */}
        <Route path="finance" element={<FinanceHome />} />
        <Route path="finance/payments" element={<PaymentsPage />} />
        <Route path="finance/payments/:partyType/:partyId" element={<PartyStatementPage />} />
        <Route path="finance/invoices" element={<InvoicesPage />} />
        {/* No `invoices/new`: an invoice is raised from its shipment, because its money is
            derived from what shipped. The same reason an order only comes from a proforma. */}
        <Route path="finance/invoices/:id" element={<InvoiceDetailPage />} />

        {/* The money pages moved. A bookmark or a pasted link must still land, and
            `*` after the prefix carries the party type and id or the invoice id with it. */}
        <Route path="operations/payments/*" element={<MovedTo to="/finance/payments" />} />
        <Route path="sales/invoices/*" element={<MovedTo to="/finance/invoices" />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
