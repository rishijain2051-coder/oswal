import { Breadcrumb, Button, Card, Col, Row, Typography } from 'antd';
import { ProfileOutlined, TableOutlined, PlusOutlined, HomeOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';

const { Title, Text } = Typography;

export default function ProductModuleHome() {
  const navigate = useNavigate();
  const { hasRole } = useAuth();

  return (
    <div>
      <Breadcrumb
        style={{ marginBottom: 16 }}
        items={[{ title: <Link to="/"><HomeOutlined /></Link> }, { title: 'Products' }]}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <Title level={2} style={{ marginBottom: 2 }}>
            Product Management
          </Title>
          <Text type="secondary">Everything about your products — the source of truth for costing, operations & sales.</Text>
        </div>
        {hasRole('Operator') && (
          <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => navigate('/products/new')}>
            Create Product
          </Button>
        )}
      </div>

      <Row gutter={[20, 20]}>
        <Col xs={24} md={12}>
          <Card className="module-card" onClick={() => navigate('/products/catalogue')} style={{ borderTop: '4px solid #6d4c41', height: '100%' }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              <div style={{ fontSize: 40, color: '#6d4c41' }}>
                <ProfileOutlined />
              </div>
              <div>
                <Title level={3} style={{ marginTop: 0, marginBottom: 4 }}>
                  Product Catalogue
                </Title>
                <Text type="secondary">
                  Executive summary of every product — codes, classification, buyer and headline Ex-Factory / FOB costs at a glance.
                </Text>
              </div>
            </div>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card className="module-card" onClick={() => navigate('/products/list')} style={{ borderTop: '4px solid #8d6e63', height: '100%' }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              <div style={{ fontSize: 40, color: '#8d6e63' }}>
                <TableOutlined />
              </div>
              <div>
                <Title level={3} style={{ marginTop: 0, marginBottom: 4 }}>
                  Product Details
                </Title>
                <Text type="secondary">
                  Full, filterable grid of products. Open any product for its complete detail, costing sheet, related items and images. Create & edit here.
                </Text>
              </div>
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
