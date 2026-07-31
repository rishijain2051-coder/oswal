import { Card, Col, Row, Typography, Tag } from 'antd';
import {
  TeamOutlined,
  AppstoreOutlined,
  ToolOutlined,
  ShoppingOutlined,
  FileDoneOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

const { Title, Text } = Typography;

/**
 * Orders comes first and stands alone, because the order is the record everything else hangs
 * off: open one and you reach its proforma, products, material sheets, cartons, containers,
 * invoices and money without going back to a list.
 */
const MODULES = [
  { key: 'orders', title: 'Orders', icon: <FileDoneOutlined />, path: '/operations/orders', ready: true, desc: 'The hub — the production board, and everything an order later became.' },
  { key: 'operations', title: 'Operations', icon: <ToolOutlined />, path: '/operations', ready: true, desc: 'Proformas, delivery, material sheets, suppliers & raw stock.' },
  { key: 'sales', title: 'Dispatch', icon: <ShoppingOutlined />, path: '/sales', ready: true, desc: 'Finished stock, packing, containers & shipments.' },
  { key: 'finance', title: 'Finance', icon: <WalletOutlined />, path: '/finance', ready: true, desc: 'Receivables, payables, receipts, payments & invoices.' },
  { key: 'manforce', title: 'Manforce', icon: <TeamOutlined />, path: '/manforce', ready: true, desc: 'Workers, muster roll, wages, advances & statutory dues.' },
  { key: 'product', title: 'Products', icon: <AppstoreOutlined />, path: '/products', ready: true, desc: 'Catalogue, product details & costing sheets.' },
];

export default function HomePage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <Title level={2} style={{ marginBottom: 4 }}>
          Welcome, {user?.name?.split(' ')[0]} 👋
        </Title>
        <Text type="secondary">Choose a module to begin.</Text>
      </div>
      <Row gutter={[20, 20]}>
        {MODULES.map((m) => (
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
