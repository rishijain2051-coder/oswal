/**
 * Finance — every figure the factory's money position is made of, in one place.
 *
 * Nothing on this page is typed and nothing is added up here. It reads `/finance/summary`,
 * which `financeTotals()` also feeds the dashboard, so the two can never disagree — the same
 * rule that makes the order page and the Payments page agree. There is deliberately no
 * "adjust" or "opening balance" control anywhere in this section: a receivable is what an
 * order or an invoice is worth less what came in, and a payable is what the board accrued
 * less what went out.
 */
import { Badge, Breadcrumb, Card, Col, List, Row, Space, Statistic, Tag, Tooltip, Typography } from 'antd';
import { HomeOutlined, WalletOutlined, FileProtectOutlined, BankOutlined, TeamOutlined, ShopOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { useFinanceSummary, usePayables, useReceivables } from '../../api/ops';
import { useInvoices, INVOICE_STATUS_COLOR } from '../../api/sales';
import { money, num } from '../../util/format';
import ForexSummaryCard, { useForexSummary } from '../../components/ForexSummaryCard';

const { Title, Text } = Typography;

const SECTIONS = [
  {
    key: 'payments',
    title: 'Receipts & Payments',
    icon: <WalletOutlined />,
    path: '/finance/payments',
    desc: 'Record what came in and what went out. Which debt it settles is worked out by FIFO, never chosen.',
  },
  {
    key: 'invoices',
    title: 'Invoices',
    icon: <FileProtectOutlined />,
    path: '/finance/invoices',
    desc: 'Bill what has shipped. Prices are copied from the order; no total is stored.',
  },
];

/** The money owed to us and by us, by party type — the payables page in one line each. */
const PARTY_ICON: Record<string, JSX.Element> = {
  JOBWORK: <ShopOutlined />,
  SUPPLIER: <ShopOutlined />,
  WORKER: <TeamOutlined />,
  CONTRACTOR: <TeamOutlined />,
  STATUTORY: <SafetyCertificateOutlined />,
};

export default function FinanceHome() {
  const navigate = useNavigate();
  const { data: s } = useFinanceSummary();
  const { data: recv } = useReceivables();
  const { data: payables } = usePayables();
  const { data: forex } = useForexSummary();
  const { data: invoices } = useInvoices();

  const basis = s?.receivableBasis ?? 'ORDER';
  // Biggest debts first — the rows somebody actually has to chase.
  const topReceivables = [...(recv?.rows ?? [])].sort((a, b) => b.balanceInr - a.balanceInr).slice(0, 6);
  const topPayables = [...(payables ?? [])].filter((p) => !p.isProvision && p.balance > 0).sort((a, b) => b.balance - a.balance).slice(0, 6);
  const drafts = (invoices ?? []).filter((i) => i.status === 'DRAFT');

  return (
    <div>
      <Breadcrumb style={{ marginBottom: 16 }} items={[{ title: <Link to="/"><HomeOutlined /></Link> }, { title: 'Finance' }]} />
      <Title level={2} style={{ marginBottom: 2 }}>
        Finance
      </Title>
      <Text type="secondary">
        What we are owed, what we owe, and every receipt behind it — all derived from the orders, the board and the invoices.
      </Text>

      <Row gutter={[16, 16]} style={{ margin: '16px 0' }}>
        <Col xs={12} md={6}>
          <Card size="small" hoverable onClick={() => navigate('/finance/payments')}>
            <Statistic title="To collect (₹)" value={num(s?.receivableInr ?? 0, 0)} valueStyle={{ color: '#237804' }} />
            {/* Which question that figure answers depends on one Admin setting, so say so. */}
            <Tooltip
              title={
                basis === 'INVOICE'
                  ? 'Receivables are ISSUED INVOICES less receipts. Confirmed orders not yet billed are the order book, shown beside it.'
                  : 'Receivables are ORDER values less receipts — how the app has always worked.'
              }
            >
              <Tag color={basis === 'INVOICE' ? 'purple' : 'default'} style={{ marginTop: 4 }}>
                {basis === 'INVOICE' ? 'invoice basis' : 'order basis'}
              </Tag>
            </Tooltip>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" hoverable onClick={() => navigate('/finance/payments')}>
            <Statistic title="Owed out (₹)" value={num(s?.payableInr ?? 0, 0)} valueStyle={{ color: '#cf1322' }} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              jobwork {num(s?.jobworkDue ?? 0, 0)} · material {num(s?.materialDue ?? 0, 0)} · wages {num(s?.wagesDue ?? 0, 0)}
            </Text>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" hoverable onClick={() => navigate('/finance/payments')}>
            <Statistic title="Received (₹)" value={num(s?.receivedInr ?? 0, 0)} />
            {(s?.buyerCreditInr ?? 0) > 0 && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                incl. {money(s!.buyerCreditInr, '₹')} on account
              </Text>
            )}
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" hoverable onClick={() => navigate('/finance/invoices')}>
            <Statistic title="Invoiced (₹)" value={num(s?.invoicedInr ?? 0, 0)} />
            {/* Only under the invoice basis is "confirmed but not billed" a separate figure. */}
            {basis === 'INVOICE' && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                order book {money(s?.orderBookInr ?? 0, '₹')} not yet billed
              </Text>
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} md={12}>
          <Card
            size="small"
            title="Biggest amounts to collect"
            extra={<Link to="/finance/payments">All receivables</Link>}
          >
            <List
              size="small"
              dataSource={topReceivables}
              locale={{ emptyText: 'Nothing outstanding' }}
              renderItem={(r) => (
                <List.Item onClick={() => navigate(`/finance/payments/buyer/${r.buyerId}`)} style={{ cursor: 'pointer' }}>
                  <span>
                    <Link to={`/operations/orders/${r.orderId}`} style={{ fontWeight: 600 }}>
                      {r.orderNumber}
                    </Link>{' '}
                    <Text type="secondary">{r.buyerName}</Text>
                  </span>
                  <span>
                    <Text strong>{money(r.balance, r.symbol)}</Text>
                    {r.currency !== 'INR' && (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {' '}
                        ≈ {money(r.balanceInr, '₹')}
                      </Text>
                    )}
                  </span>
                </List.Item>
              )}
            />
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card size="small" title="Biggest amounts owed out" extra={<Link to="/finance/payments">All payables</Link>}>
            <List
              size="small"
              dataSource={topPayables}
              locale={{ emptyText: 'Nothing owed out' }}
              renderItem={(p) => (
                <List.Item
                  onClick={() => p.partyId != null && navigate(`/finance/payments/${p.partyType.toLowerCase()}/${p.partyId}`)}
                  style={{ cursor: p.partyId != null ? 'pointer' : 'default' }}
                >
                  <Space size={6}>
                    {PARTY_ICON[p.partyType] ?? <BankOutlined />}
                    <Text>{p.partyName}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {p.partyType.toLowerCase()}
                    </Text>
                  </Space>
                  <Text strong>{money(p.balance, '₹')}</Text>
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>

      {/* Drafts are the only invoices anybody has to act on: a draft is not a debt yet. */}
      {drafts.length > 0 && (
        <Card
          size="small"
          style={{ marginBottom: 16 }}
          title={
            <Badge count={drafts.length} offset={[12, 0]} color="#faad14">
              Invoices still in draft
            </Badge>
          }
          extra={<Link to="/finance/invoices">All invoices</Link>}
        >
          <List
            size="small"
            dataSource={drafts.slice(0, 6)}
            renderItem={(i) => (
              <List.Item onClick={() => navigate(`/finance/invoices/${i.id}`)} style={{ cursor: 'pointer' }}>
                <span>
                  <b>{i.number}</b> · {i.buyer?.name}
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {' '}
                    {dayjs(i.invoiceDate).format('DD MMM')}
                  </Text>
                </span>
                <span>
                  <Tag color={INVOICE_STATUS_COLOR[i.status]}>{i.status}</Tag>
                  <Text strong>{money(i.totals.grandTotal, i.currency?.symbol ?? '₹')}</Text>
                </span>
              </List.Item>
            )}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            A draft has not been sent to anybody, so it is neither owed nor a reduction of the order book. Issue it to make it a debt.
          </Text>
        </Card>
      )}

      <Row gutter={[16, 16]}>
        {SECTIONS.map((x) => (
          <Col key={x.key} xs={24} sm={12}>
            <Card className="module-card" onClick={() => navigate(x.path)} style={{ height: '100%', borderTop: '4px solid #6d4c41' }}>
              <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                <div style={{ fontSize: 30, color: '#6d4c41' }}>{x.icon}</div>
                <div>
                  <Title level={4} style={{ margin: 0 }}>
                    {x.title}
                  </Title>
                  <Text type="secondary">{x.desc}</Text>
                </div>
              </div>
            </Card>
          </Col>
        ))}
      </Row>

      {/* Only worth the space when money is actually owed in another currency. */}
      {forex?.hasForeignExposure && (
        <div style={{ marginTop: 16 }}>
          <ForexSummaryCard />
        </div>
      )}
    </div>
  );
}
