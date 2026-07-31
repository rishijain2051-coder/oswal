import { Link } from 'react-router-dom';
import { Breadcrumb, Card, Col, Row, Statistic, Tag, Typography } from 'antd';
import { BoxPlotOutlined, ContainerOutlined, FileProtectOutlined, HomeOutlined, InboxOutlined } from '@ant-design/icons';
import { useSalesDashboard } from '../../api/sales';
import { useFinanceSummary } from '../../api/ops';
import { useAuth } from '../../auth/AuthContext';

const { Title, Text } = Typography;

const SECTIONS = [
  { key: 'stock', title: 'Finished Stock', icon: <InboxOutlined />, path: '/sales/stock', desc: 'What is finished and still here — worked out from the board, never typed.' },
  { key: 'packing', title: 'Packing', icon: <BoxPlotOutlined />, path: '/sales/packing', desc: 'Put finished pieces into cartons, with dims and weights from the product.' },
  { key: 'shipments', title: 'Shipments', icon: <ContainerOutlined />, path: '/sales/shipments', desc: 'Load containers, check the fit, and dispatch.', manager: true },
  // Invoicing is money, so it lives in Finance now. The way through to it stays here,
  // because "shipped, not invoiced" above is the row that sends you looking for it.
  { key: 'invoices', title: 'Invoices', icon: <FileProtectOutlined />, path: '/finance/invoices', desc: 'In Finance. Bill what has gone out; prices come from the order.', manager: true },
];

const money = (v: number) => `₹${(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

export default function SalesHome() {
  const { can } = useAuth();
  const { data: d } = useSalesDashboard();
  const { data: fin } = useFinanceSummary();
  const canSeeMoney = can('money.view');
  const invoiceBasis = fin?.receivableBasis === 'INVOICE';

  return (
    <div>
      <Breadcrumb style={{ marginBottom: 16 }} items={[{ title: <Link to="/"><HomeOutlined /></Link> }, { title: 'Dispatch' }]} />
      <Title level={3} style={{ marginTop: 0 }}>
        Dispatch
      </Title>
      <Text type="secondary">Finished stock → packing → container → dispatch. Billing what left is in Finance.</Text>

      <Row gutter={[16, 16]} style={{ marginTop: 20 }}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Finished on hand" value={d?.finishedOnHand ?? 0} suffix="pc" />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Ready to pack" value={d?.readyToPack ?? 0} suffix="pc" />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Packed, awaiting dispatch" value={d?.packedAwaitingShipment ?? 0} suffix="pc" />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            {/* The most actionable row in the module: it has gone, and nobody has billed it. */}
            <Statistic title="Shipped, not invoiced" value={d?.shippedNotInvoiced ?? 0} valueStyle={{ color: (d?.shippedNotInvoiced ?? 0) > 0 ? '#c62828' : undefined }} />
          </Card>
        </Col>
      </Row>

      {canSeeMoney && (
        <Row gutter={[16, 16]} style={{ marginTop: 4 }}>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="Shipments this month" value={d?.shipmentsThisMonth ?? 0} />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="Invoiced (issued)" value={money(d?.invoicedInr ?? 0)} />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="To collect" value={money(fin?.receivableInr ?? 0)} />
              <Text type="secondary" style={{ fontSize: 11 }}>
                {invoiceBasis ? 'Invoiced, unpaid' : 'Order value, unpaid'}
              </Text>
            </Card>
          </Col>
          {/* Only meaningful on the invoice basis — on the order basis the order IS the debt. */}
          {invoiceBasis && (
            <Col xs={12} md={6}>
              <Card size="small">
                <Statistic title="Order book (un-invoiced)" value={money(fin?.orderBookInr ?? 0)} />
                <Text type="secondary" style={{ fontSize: 11 }}>
                  Confirmed, not yet billed
                </Text>
              </Card>
            </Col>
          )}
        </Row>
      )}

      <Row gutter={[16, 16]} style={{ marginTop: 20 }}>
        {SECTIONS.filter((s) => !s.manager || can('shipments.view')).map((s) => (
          <Col xs={24} sm={12} lg={6} key={s.key}>
            <Link to={s.path}>
              <Card hoverable style={{ borderTop: '3px solid #4e342e', height: '100%' }}>
                <div style={{ fontSize: 26, color: '#4e342e' }}>{s.icon}</div>
                <Title level={5} style={{ marginBottom: 4 }}>
                  {s.title}
                </Title>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {s.desc}
                </Text>
                {s.manager && (
                  <div style={{ marginTop: 8 }}>
                    <Tag color="default">Manager+</Tag>
                  </div>
                )}
              </Card>
            </Link>
          </Col>
        ))}
      </Row>
    </div>
  );
}
