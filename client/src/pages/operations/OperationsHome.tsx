import { Badge, Breadcrumb, Card, Col, List, Row, Space, Statistic, Tag, Typography } from 'antd';
import { HomeOutlined, FileDoneOutlined, FileTextOutlined, ShopOutlined, InboxOutlined, ProfileOutlined, WalletOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useOpsDashboard, PROFORMA_STATUS_COLOR, type DeliveryStatusResponse } from '../../api/ops';
import { num } from '../../util/format';
import ForexSummaryCard, { useForexSummary } from '../../components/ForexSummaryCard';

const { Title, Text } = Typography;

const SECTIONS = [
  { key: 'orders', title: 'Orders', icon: <FileDoneOutlined />, path: '/operations/orders', desc: 'The hub. Every piece, every stage, and everything the order later became.' },
  { key: 'proformas', title: 'Proformas', icon: <FileTextOutlined />, path: '/operations/proformas', desc: 'Make a PI, mail it to the buyer, record accept or reject.' },
  { key: 'sheets', title: 'Material Sheets', icon: <ProfileOutlined />, path: '/operations/sheets', desc: 'What each job needs, printable per section.' },
  { key: 'suppliers', title: 'Suppliers', icon: <ShopOutlined />, path: '/operations/suppliers', desc: 'Material and jobwork vendors.' },
  { key: 'stock', title: 'Raw Stock', icon: <InboxOutlined />, path: '/operations/stock', desc: 'Raw-material inward, outward and balances.' },
  // Money moved to Finance, but the two figures it drives are worked out from these orders,
  // so the way through to them belongs here.
  { key: 'finance', title: 'Finance', icon: <WalletOutlined />, path: '/finance', desc: 'What buyers owe us and what we owe out — worked out from these orders.' },
];

export default function OperationsHome() {
  const navigate = useNavigate();
  const { data: d } = useOpsDashboard();

  const { data: forex } = useForexSummary();
  // Cheap and derived; the dashboard is the natural place to notice a slipping order.
  const { data: delivery } = useQuery<DeliveryStatusResponse>({ queryKey: ['delivery-status'], queryFn: async () => (await api.get('/orders/delivery-status')).data });

  return (
    <div>
      <Breadcrumb style={{ marginBottom: 16 }} items={[{ title: <Link to="/"><HomeOutlined /></Link> }, { title: 'Operations' }]} />
      <Title level={2} style={{ marginBottom: 2 }}>
        Operations
      </Title>
      <Text type="secondary">Proforma → order → production board. The order carries it from there — packing, dispatch and billing all hang off it.</Text>

      <Row gutter={[16, 16]} style={{ margin: '16px 0' }}>
        <Col xs={12} md={6}>
          <Card size="small" hoverable onClick={() => navigate('/operations/proformas')}>
            <Statistic title="PIs awaiting a reply" value={d?.awaitingDecision ?? 0} valueStyle={{ color: '#1677ff' }} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" hoverable onClick={() => navigate('/operations/orders')}>
            <Statistic title="Live orders" value={d?.pendingOrders ?? 0} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" hoverable onClick={() => navigate('/operations/orders')}>
            <Statistic title="Pieces in production" value={d?.inProduction ?? 0} valueStyle={{ color: '#874d00' }} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" hoverable onClick={() => navigate('/operations/orders')}>
            <Statistic title="Pieces at vendors" value={d?.atVendors ?? 0} valueStyle={{ color: '#d4380d' }} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" hoverable onClick={() => navigate('/operations/orders')}>
            <Statistic title="Not started" value={d?.pendingPieces ?? 0} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" hoverable onClick={() => navigate('/operations/orders')}>
            <Statistic title="Finished pieces" value={d?.finishedPieces ?? 0} valueStyle={{ color: '#237804' }} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" hoverable onClick={() => navigate('/finance/payments')}>
            <Statistic title="To collect (₹)" value={num(d?.receivable ?? 0, 0)} valueStyle={{ color: '#237804' }} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" hoverable onClick={() => navigate('/finance/payments')}>
            <Statistic title="Owed out (₹)" value={num(d?.payable ?? 0, 0)} valueStyle={{ color: '#cf1322' }} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} md={8}>
          <Card size="small" title="Recent proformas">
            <List
              size="small"
              dataSource={d?.recentProformas ?? []}
              locale={{ emptyText: 'No proformas yet' }}
              renderItem={(p) => (
                <List.Item onClick={() => navigate(`/operations/proformas/${p.id}`)} style={{ cursor: 'pointer' }}>
                  <span>
                    <b>{p.number}</b> · {p.buyer}
                  </span>
                  <span>
                    <Tag color={PROFORMA_STATUS_COLOR[p.status] ?? 'default'}>{p.status}</Tag>
                    <Text type="secondary">{dayjs(p.date).format('DD MMM')}</Text>
                  </span>
                </List.Item>
              )}
            />
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card size="small" title="Pieces sitting with vendors" extra={<Text type="secondary" style={{ fontSize: 12 }}>jobwork {num(d?.jobworkAccrued ?? 0, 0)} ₹</Text>}>
            <List
              size="small"
              dataSource={d?.vendorLoad ?? []}
              locale={{ emptyText: 'Nothing out for jobwork' }}
              renderItem={(v) => (
                <List.Item onClick={() => navigate('/finance/payments')} style={{ cursor: 'pointer' }}>
                  <span>{v.vendorName}</span>
                  <Tag color="volcano">{v.pieces} pcs</Tag>
                </List.Item>
              )}
            />
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card size="small" title="Low stock alerts">
            <List
              size="small"
              dataSource={d?.lowStock ?? []}
              locale={{ emptyText: 'All stock above reorder level' }}
              renderItem={(it) => (
                <List.Item onClick={() => navigate('/operations/stock')} style={{ cursor: 'pointer' }}>
                  <span>{it.name}</span>
                  <span>
                    <Tag color="red">
                      {num(it.balance, 2)} {it.unit}
                    </Tag>
                    <Text type="secondary">reorder ≤ {num(it.reorderLevel, 0)}</Text>
                  </span>
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        {SECTIONS.map((s) => (
          <Col key={s.key} xs={24} sm={12} lg={8}>
            <Card className="module-card" onClick={() => navigate(s.path)} style={{ height: '100%', borderTop: '4px solid #6d4c41' }}>
              <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                <div style={{ fontSize: 30, color: '#6d4c41' }}>{s.icon}</div>
                <div>
                  <Title level={4} style={{ margin: 0 }}>
                    {s.key === 'proformas' && (d?.awaitingDecision ?? 0) > 0 ? (
                      <Badge count={d!.awaitingDecision} offset={[10, -2]} color="#1677ff">
                        {s.title}
                      </Badge>
                    ) : (
                      s.title
                    )}
                  </Title>
                  <Text type="secondary">{s.desc}</Text>
                </div>
              </div>
            </Card>
          </Col>
        ))}
      </Row>

      {/* Only worth the space when something is actually late or slipping. */}
      {delivery && ((delivery.counts.LATE ?? 0) > 0 || (delivery.counts.AT_RISK ?? 0) > 0) && (
        <Card size="small" style={{ marginTop: 16 }} title="Delivery">
          <Space size={28} wrap>
            <Link to="/operations/delivery">
              <Space size={6}>
                <Text type="secondary">Late</Text>
                <Text strong style={{ fontSize: 20, color: '#c62828' }}>
                  {delivery.counts.LATE ?? 0}
                </Text>
              </Space>
            </Link>
            <Link to="/operations/delivery">
              <Space size={6}>
                <Text type="secondary">At risk</Text>
                <Text strong style={{ fontSize: 20, color: '#ef6c00' }}>
                  {delivery.counts.AT_RISK ?? 0}
                </Text>
              </Space>
            </Link>
            <Link to="/operations/delivery">See the delivery tracker</Link>
          </Space>
        </Card>
      )}

      {/* Only worth the space when money is actually owed in another currency. */}
      {forex?.hasForeignExposure && (
        <div style={{ marginTop: 16 }}>
          <ForexSummaryCard compact />
        </div>
      )}
    </div>
  );
}
