/**
 * The front page. A picker, plus the handful of figures worth seeing before you pick.
 *
 * The strip at the top is deliberately short: only rows somebody would ACT on today — orders
 * running late, pieces waiting to be packed, dispatches that have gone out unbilled, money to
 * collect. Everything else belongs on the module dashboard that owns it. Each tile is a link
 * to the page that explains it, because a number nobody can drill into is decoration.
 *
 * Nothing here is computed. `/ops/dashboard`, `/sales/dashboard`, `/finance/summary` and
 * `/orders/delivery-status` are the same endpoints the module dashboards read, so this page
 * cannot show a figure the rest of the app disagrees with.
 */
import { Card, Col, Row, Typography, Tag, Tooltip } from 'antd';
import {
  TeamOutlined,
  AppstoreOutlined,
  ToolOutlined,
  ShoppingOutlined,
  FileDoneOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { api } from '../api/client';
import { useFinanceSummary, useOpsDashboard, type DeliveryStatusResponse } from '../api/ops';
import { useSalesDashboard } from '../api/sales';
import { num } from '../util/format';

const { Title, Text } = Typography;

/**
 * Orders comes first and stands alone, because the order is the record everything else hangs
 * off: open one and you reach its proforma, products, material sheets, cartons, containers,
 * invoices and money without going back to a list.
 */
/**
 * `needs` lists the permissions that can open the module, ANY of which is enough — they match
 * the `NeedsAny` gate on each section's route in App.tsx. A card whose module the visitor
 * cannot enter is not shown at all: the front page is meant to say where everything lives, and
 * six cards of which three lead to a refusal say the opposite.
 */
const MODULES = [
  { key: 'orders', title: 'Orders', icon: <FileDoneOutlined />, path: '/operations/orders', ready: true, desc: 'The hub — the production board, and everything an order later became.', needs: ['orders.view'] },
  { key: 'operations', title: 'Operations', icon: <ToolOutlined />, path: '/operations', ready: true, desc: 'Proformas, delivery, material sheets, suppliers & raw stock.', needs: ['orders.view', 'proformas.view', 'sheets.view', 'stock.view', 'suppliers.view'] },
  { key: 'sales', title: 'Dispatch', icon: <ShoppingOutlined />, path: '/sales', ready: true, desc: 'Finished stock, packing, containers & shipments.', needs: ['finished.view', 'packing.view', 'shipments.view'] },
  { key: 'finance', title: 'Finance', icon: <WalletOutlined />, path: '/finance', ready: true, desc: 'Receivables, payables, receipts, payments & invoices.', needs: ['money.view', 'payments.view', 'invoices.view'] },
  { key: 'manforce', title: 'Manforce', icon: <TeamOutlined />, path: '/manforce', ready: true, desc: 'Workers, muster roll, wages, advances & statutory dues.', needs: ['workers.view', 'wages.view'] },
  { key: 'product', title: 'Products', icon: <AppstoreOutlined />, path: '/products', ready: true, desc: 'Catalogue, product details & costing sheets.', needs: ['products.view'] },
];

/** One figure, what it means, and where to go about it. */
function Kpi({
  label,
  value,
  hint,
  to,
  colour,
  urgent,
}: {
  label: string;
  value: string | number;
  hint: string;
  to: string;
  colour?: string;
  urgent?: boolean;
}) {
  const navigate = useNavigate();
  return (
    <Col xs={12} md={8} lg={4}>
      <Tooltip title={hint}>
        <Card
          size="small"
          hoverable
          onClick={() => navigate(to)}
          style={{ borderLeft: `3px solid ${urgent ? '#c62828' : '#d7ccc8'}` }}
          styles={{ body: { padding: '10px 12px' } }}
        >
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.2, color: colour ?? '#4e342e' }}>{value}</div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {label}
          </Text>
        </Card>
      </Tooltip>
    </Col>
  );
}

export default function HomePage() {
  const navigate = useNavigate();
  const { user, can, canAny } = useAuth();
  const { data: ops } = useOpsDashboard();
  const { data: sales } = useSalesDashboard();
  // Money is Manager+ everywhere else in the app, so it must not appear here either. The
  // fetch is unconditional and the RENDER is gated, matching SalesHome — `/finance/summary`
  // is not itself role-restricted, and a hook that changes shape by role is worse.
  const canSeeMoney = can('money.view');
  const { data: fin } = useFinanceSummary();
  const { data: delivery } = useQuery<DeliveryStatusResponse>({
    queryKey: ['delivery-status'],
    queryFn: async () => (await api.get('/orders/delivery-status')).data,
  });

  const late = delivery?.counts.LATE ?? 0;
  const atRisk = delivery?.counts.AT_RISK ?? 0;
  const unbilled = sales?.shippedNotInvoiced ?? 0;

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Title level={2} style={{ marginBottom: 4 }}>
          Welcome, {user?.name?.split(' ')[0]} 👋
        </Title>
        <Text type="secondary">What needs attention today, and where everything lives.</Text>
      </div>

      <Row gutter={[12, 12]} style={{ marginBottom: 24 }}>
        <Kpi
          label="orders late"
          value={late}
          urgent={late > 0}
          colour={late > 0 ? '#c62828' : undefined}
          hint="Past the delivery date the buyer asked for, with pieces still unfinished. Derived from the board on every read."
          to="/operations/delivery"
        />
        <Kpi
          label="at risk"
          value={atRisk}
          urgent={atRisk > 0}
          colour={atRisk > 0 ? '#ef6c00' : undefined}
          hint="Inside the last week before delivery and less than 80% finished. Far out, a slow start is normal and is deliberately not flagged."
          to="/operations/delivery"
        />
        <Kpi
          label="pcs in production"
          value={num(ops?.inProduction ?? 0, 0)}
          hint="On the floor or at a vendor, somewhere between the first stage and finished."
          to="/operations/orders"
        />
        <Kpi
          label="pcs ready to pack"
          value={num(sales?.readyToPack ?? 0, 0)}
          hint="Finished, still here, and not yet in a carton. A dispatch can only draw on cartons."
          to="/sales/packing"
        />
        <Kpi
          label="shipped, unbilled"
          value={unbilled}
          urgent={unbilled > 0}
          colour={unbilled > 0 ? '#c62828' : undefined}
          hint="Dispatches that have left with no invoice issued against them — the most actionable row in the app."
          to="/sales/shipments"
        />
        {canSeeMoney ? (
          <Kpi
            label="to collect (₹)"
            value={num(fin?.receivableInr ?? 0, 0)}
            colour="#237804"
            hint={
              fin?.receivableBasis === 'INVOICE'
                ? 'Issued invoices less receipts. Confirmed orders not yet billed are the order book, shown separately in Finance.'
                : 'Order values less receipts, oldest debt settled first.'
            }
            to="/finance"
          />
        ) : (
          <Kpi
            label="pcs finished"
            value={num(ops?.finishedPieces ?? 0, 0)}
            hint="Off the board and on the floor, packed or loose."
            to="/sales/stock"
          />
        )}
      </Row>

      <Row gutter={[20, 20]}>
        {MODULES.filter((m) => canAny(...m.needs)).map((m) => (
          <Col key={m.key} xs={24} sm={12} lg={8}>
            <Card
              className="module-card"
              onClick={() => navigate(m.path)}
              style={{ height: '100%', borderTop: `4px solid ${m.ready ? '#6d4c41' : '#d7ccc8'}` }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div style={{ fontSize: 34, color: m.ready ? '#6d4c41' : '#bcaaa4' }}>{m.icon}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Title level={4} style={{ margin: 0 }}>
                      {m.title}
                    </Title>
                    {m.ready ? <Tag color="green">Live</Tag> : <Tag>Soon</Tag>}
                  </div>
                  <Text type="secondary">{m.desc}</Text>
                </div>
              </div>
            </Card>
          </Col>
        ))}
      </Row>
    </div>
  );
}
