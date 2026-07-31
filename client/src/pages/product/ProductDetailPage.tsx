import { Breadcrumb, Button, Card, Col, Descriptions, Empty, Result, Row, Skeleton, Space, Tabs, Tag, Tooltip, Typography } from 'antd';
import ChangeLogList from '../../components/ChangeLogList';
import { HomeOutlined, EditOutlined, ArrowLeftOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useProduct } from '../../api/hooks';
import { useAuth } from '../../auth/AuthContext';
import { money, statusColor, num } from '../../util/format';
import CostingSheetView from '../../components/CostingSheetView';
import ProductImages from '../../components/ProductImages';
import ProductThumb from '../../components/ProductThumb';
import type { RelatedLink } from '../../api/types';

const { Title, Text } = Typography;

const RELATION_LABEL: Record<string, string> = { VARIANT: 'Variant', PART: 'Part / Component', ACCESSORY: 'Accessory', SET: 'Same Set' };

export default function ProductDetailPage({ catalogueMode = false }: { catalogueMode?: boolean } = {}) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { hasRole } = useAuth();
  const { data: p, isLoading, isError } = useProduct(id);

  const backTo = catalogueMode ? '/products/catalogue' : '/products/list';

  if (isLoading) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (isError || !p) return <Result status="404" title="Product not found" extra={<Button onClick={() => navigate(backTo)}>Back</Button>} />;

  const symbol = p.costSheet?.currency?.symbol ?? '₹';
  const dim = (l?: number | null, w?: number | null, h?: number | null) =>
    [l, w, h].some((v) => v != null) ? [l, w, h].filter((v) => v != null).map((v) => num(v!, 2)).join(' × ') + ' in' : '—';

  const detailsTab = (
    <Row gutter={16}>
      <Col xs={24} lg={16}>
        <Card title="Product Details" style={{ marginBottom: 16 }}>
          <Descriptions column={2} size="small" bordered>
            <Descriptions.Item label="Factory Code">{p.factoryCode}</Descriptions.Item>
            <Descriptions.Item label="Status"><Tag color={statusColor(p.status)}>{p.status}</Tag></Descriptions.Item>
            <Descriptions.Item label="Name">{p.name}</Descriptions.Item>
            <Descriptions.Item label="Alias">{p.alias || '—'}</Descriptions.Item>
            <Descriptions.Item label="Item Type">{p.itemType?.value || '—'}</Descriptions.Item>
            <Descriptions.Item label="Product Type">{p.productType?.value || '—'}</Descriptions.Item>
            <Descriptions.Item label="Size">{p.size?.value || '—'}</Descriptions.Item>
            <Descriptions.Item label="Colour">{p.colour?.value || '—'}</Descriptions.Item>
            <Descriptions.Item label="Material">{p.material?.value || '—'}</Descriptions.Item>
            <Descriptions.Item label="Finish">{p.finish?.value || '—'}</Descriptions.Item>
            <Descriptions.Item label="Unit">{p.unit?.code || '—'}</Descriptions.Item>
            <Descriptions.Item label="Stage Line">
              {p.stageLine ? (
                <Tooltip title={p.stageLine.steps.map((s) => s.name).join(' → ')}>
                  <Tag color="#6d4c41">{p.stageLine.code}</Tag>
                  {p.stageLine.name}
                </Tooltip>
              ) : (
                '—'
              )}
            </Descriptions.Item>
            <Descriptions.Item label="Description" span={2}>{p.description || '—'}</Descriptions.Item>
          </Descriptions>
        </Card>

        <Card title="Buyers" style={{ marginBottom: 16 }}>
          {p.buyers.length ? (
            <Descriptions column={1} size="small" bordered>
              {p.buyers.map((b) => (
                <Descriptions.Item key={b.id} label={`${b.buyer?.code} · ${b.buyer?.name}`}>
                  Buyer article code: <Text strong>{b.buyerCode || '—'}</Text>
                  {b.buyer?.country ? <Text type="secondary"> · {b.buyer.country}</Text> : null}
                </Descriptions.Item>
              ))}
            </Descriptions>
          ) : (
            <Empty description="No buyers linked" />
          )}
        </Card>
      </Col>

      <Col xs={24} lg={8}>
        <Card title="Physical & Packing" size="small">
          <Descriptions column={1} size="small">
            <Descriptions.Item label="Assembled (L×W×H)">{dim(p.prodLengthIn, p.prodWidthIn, p.prodHeightIn)}</Descriptions.Item>
            <Descriptions.Item label="Packed (L×W×H)">{dim(p.packLengthIn, p.packWidthIn, p.packHeightIn)}</Descriptions.Item>
            <Descriptions.Item label="Net Weight">{p.netWeightKg != null ? `${num(p.netWeightKg)} kg` : '—'}</Descriptions.Item>
            <Descriptions.Item label="Gross Weight">{p.grossWeightKg != null ? `${num(p.grossWeightKg)} kg` : '—'}</Descriptions.Item>
            <Descriptions.Item label="Pcs / Carton">{p.piecesPerCarton ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Volume — before packing">{p.volumeBeforePackingCbm != null ? `${num(p.volumeBeforePackingCbm, 3)} CBM` : '—'}</Descriptions.Item>
            <Descriptions.Item label="Volume — after packing">{p.volumeAfterPackingCbm != null ? `${num(p.volumeAfterPackingCbm, 3)} CBM` : '—'}</Descriptions.Item>
          </Descriptions>
        </Card>
        {!catalogueMode && p.costSheet?.summary && (
          <Card size="small" style={{ marginTop: 16, textAlign: 'center', background: '#efebe9' }}>
            <Text type="secondary">FOB Cost (per piece)</Text>
            <Title level={2} style={{ margin: '4px 0', color: '#4e342e' }}>{money(p.costSheet.summary.fob, symbol)}</Title>
            <Text type="secondary">Ex-Factory {money(p.costSheet.summary.exFactory, symbol)}</Text>
          </Card>
        )}
      </Col>
    </Row>
  );

  const relatedTab = p.related.length ? (
    <Space wrap size={16}>
      {p.related.map((r: RelatedLink) => (
        <Card key={r.id} size="small" hoverable style={{ width: 260 }} onClick={() => navigate(`/products/${r.relatedId}`)}>
          <div style={{ display: 'flex', gap: 12 }}>
            <ProductThumb url={r.product?.primaryImage} />
            <div>
              <Tag color="#8d6e63">{RELATION_LABEL[r.relation] ?? r.relation}</Tag>
              <div style={{ fontWeight: 600, marginTop: 4 }}>{r.product?.factoryCode}</div>
              <Text type="secondary">{r.product?.name}</Text>
            </div>
          </div>
        </Card>
      ))}
    </Space>
  ) : (
    <Empty description="No related products" />
  );

  return (
    <div>
      <Breadcrumb
        style={{ marginBottom: 16 }}
        items={[
          { title: <Link to="/"><HomeOutlined /></Link> },
          { title: <Link to="/products">Products</Link> },
          catalogueMode
            ? { title: <Link to="/products/catalogue">Product Catalogue</Link> }
            : { title: <Link to="/products/list">Product Details</Link> },
          { title: p.factoryCode },
        ]}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <ProductThumb url={p.images.find((i) => i.isPrimary)?.url ?? p.images[0]?.url} size={64} />
          <div>
            <Title level={3} style={{ margin: 0 }}>{p.name}</Title>
            <Space>
              <Text type="secondary">{p.factoryCode}</Text>
              <Tag color={statusColor(p.status)}>{p.status}</Tag>
            </Space>
          </div>
        </div>
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(backTo)}>
            {catalogueMode ? 'Back to Catalogue' : 'Back'}
          </Button>
          {!catalogueMode && hasRole('Operator') && (
            <Button type="primary" icon={<EditOutlined />} onClick={() => navigate(`/products/${p.id}/edit`)}>
              Edit
            </Button>
          )}
        </Space>
      </div>

      <Tabs
        defaultActiveKey="details"
        items={[
          { key: 'details', label: 'Details', children: detailsTab },
          // Costing sheet is hidden in catalogue (price-free) mode.
          ...(!catalogueMode
            ? [{
                key: 'costing',
                label: 'Costing Sheet',
                children: p.costSheet ? <CostingSheetView sheet={p.costSheet} symbol={symbol} /> : <Empty description="No costing sheet" />,
              }]
            : []),
          { key: 'related', label: `Related (${p.related.length})`, children: relatedTab },
          // Rate changes are money, so they stay out of the price-free catalogue view.
          ...(!catalogueMode ? [{ key: 'history', label: 'History', children: <ChangeLogList rootType="Product" rootId={p.id} what="product" /> }] : []),
          {
            key: 'images',
            label: `Images (${p.images.length})`,
            children: <ProductImages productId={p.id} images={p.images} editable={!catalogueMode && hasRole('Operator')} />,
          },
        ]}
      />
    </div>
  );
}
