import { Breadcrumb, Card, Col, Empty, Input, Row, Skeleton, Tag, Typography } from 'antd';
import { HomeOutlined, AppstoreOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { statusColor } from '../../util/format';
import type { ProductSummary } from '../../api/types';

const { Title, Text } = Typography;

function SquareImage({ url }: { url?: string | null }) {
  return (
    <div style={{ aspectRatio: '1 / 1', width: '100%', overflow: 'hidden', background: '#efebe9', display: 'grid', placeItems: 'center' }}>
      {url ? (
        <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        <AppstoreOutlined style={{ fontSize: 40, color: '#bcaaa4' }} />
      )}
    </div>
  );
}

export default function ProductCataloguePage() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['catalogue'],
    queryFn: async () => (await api.get<ProductSummary[]>('/products/catalogue')).data,
  });

  const rows = (data ?? []).filter((p) => {
    if (!q.trim()) return true;
    const s = q.toLowerCase();
    return p.factoryCode.toLowerCase().includes(s) || p.name.toLowerCase().includes(s) || (p.alias ?? '').toLowerCase().includes(s);
  });

  return (
    <div>
      <Breadcrumb
        style={{ marginBottom: 16 }}
        items={[
          { title: <Link to="/"><HomeOutlined /></Link> },
          { title: <Link to="/products">Products</Link> },
          { title: 'Product Catalogue' },
        ]}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>Product Catalogue</Title>
          <Text type="secondary">Tap any product to see its full specs. Click through — no prices here.</Text>
        </div>
        {/* A filter box needs an id/name for the browser to identify it, and
            autoComplete="off" because a search term is not data worth remembering. */}
        <Input.Search
          id="catalogue-search"
          name="catalogue-search"
          autoComplete="off"
          allowClear
          placeholder="Search code / name"
          style={{ width: 260 }}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {isLoading ? (
        <Skeleton active />
      ) : rows.length === 0 ? (
        <Empty description="No products" />
      ) : (
        <Row gutter={[16, 16]}>
          {rows.map((p) => (
            <Col key={p.id} xs={12} sm={8} md={6} lg={6}>
              <Card
                hoverable
                className="module-card"
                styles={{ body: { padding: 12 } }}
                cover={<SquareImage url={p.primaryImage} />}
                onClick={() => navigate(`/products/catalogue/${p.id}`)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
                  <Text strong style={{ fontSize: 15 }}>{p.factoryCode}</Text>
                  <Tag color={statusColor(p.status)} style={{ marginInlineEnd: 0 }}>{p.status}</Tag>
                </div>
                <div style={{ color: '#595959', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.name}>
                  {p.name}
                </div>
                {p.productType && <Text type="secondary" style={{ fontSize: 12 }}>{p.productType}{p.size ? ` · ${p.size}` : ''}</Text>}
              </Card>
            </Col>
          ))}
        </Row>
      )}
    </div>
  );
}
