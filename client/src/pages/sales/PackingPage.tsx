import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Breadcrumb, Button, Card, Popconfirm, Segmented, Space, Table, Tag, Tooltip, Typography, message } from 'antd';
import { BoxPlotOutlined, HomeOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { invalidateSales, unpackBatch, usePackingBatches, usePackQueue, type PackQueueRow } from '../../api/sales';
import { apiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import PackDrawer from './PackDrawer';

const { Title, Text } = Typography;

const FILTERS = ['To pack', 'Packed', 'All'] as const;

export default function PackingPage() {
  const qc = useQueryClient();
  const { hasRole } = useAuth();
  const canPack = hasRole('Operator');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('To pack');
  const [drawer, setDrawer] = useState<PackQueueRow[] | null>(null);

  const { data: queue = [], isLoading } = usePackQueue();
  const { data: batches = [] } = usePackingBatches();

  const rows = useMemo(
    () => queue.filter((r) => (filter === 'To pack' ? r.availableToPack > 0 : filter === 'Packed' ? r.packed > 0 : true)),
    [queue, filter]
  );

  const unpack = useMutation({
    mutationFn: unpackBatch,
    onSuccess: () => {
      message.success('Unpacked.');
      invalidateSales(qc);
    },
    onError: (e) => message.error(apiError(e)),
  });

  return (
    <div>
      <Breadcrumb
        style={{ marginBottom: 12 }}
        items={[{ title: <Link to="/"><HomeOutlined /></Link> }, { title: <Link to="/sales">Dispatch</Link> }, { title: 'Packing' }]}
      />
      <Space style={{ justifyContent: 'space-between', width: '100%', marginBottom: 12 }}>
        <Title level={4} style={{ margin: 0 }}>
          Packing
        </Title>
        {canPack && (
          <Button
            type="primary"
            icon={<BoxPlotOutlined />}
            disabled={!queue.some((r) => r.availableToPack > 0)}
            onClick={() => setDrawer(queue.filter((r) => r.availableToPack > 0))}
          >
            Pack a batch
          </Button>
        )}
      </Space>

      <Card size="small" styles={{ body: { paddingTop: 8 } }}>
        <Segmented options={FILTERS as unknown as string[]} value={filter} onChange={(v) => setFilter(v as typeof filter)} style={{ marginBottom: 10 }} />
        <Table
          size="small"
          rowKey="orderLineId"
          loading={isLoading}
          dataSource={rows}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          columns={[
            { title: 'Order', render: (_, r) => <Link to={`/operations/orders/${r.orderId}`}>{r.orderNumber}</Link> },
            { title: 'Buyer', dataIndex: 'buyerName' },
            { title: 'Product', render: (_, r) => `${r.productCode} — ${r.productName}` },
            { title: 'Due', dataIndex: 'deliveryDate', width: 100, render: (v: string | null) => (v ? dayjs(v).format('DD MMM') : '—') },
            { title: 'Ordered', dataIndex: 'ordered', align: 'right' as const, width: 80 },
            { title: 'Finished', dataIndex: 'finished', align: 'right' as const, width: 80 },
            { title: 'Packed', dataIndex: 'packed', align: 'right' as const, width: 80 },
            {
              title: 'To pack',
              dataIndex: 'availableToPack',
              align: 'right' as const,
              width: 80,
              render: (v: number) => <b style={{ color: v > 0 ? '#4e342e' : undefined }}>{v}</b>,
            },
            {
              title: 'Cartons',
              width: 110,
              render: (_, r) =>
                r.availableToPack > 0 ? (
                  <Tooltip title={r.lastCartonPieces > 0 ? `the last carton would hold ${r.lastCartonPieces} pc` : 'divides evenly'}>
                    <Text type="secondary">
                      {r.impliedCartons} × {r.piecesPerCarton ?? 1}
                    </Text>
                  </Tooltip>
                ) : null,
            },
            ...(canPack
              ? [
                  {
                    title: '',
                    width: 80,
                    render: (_: unknown, r: PackQueueRow) =>
                      r.availableToPack > 0 ? (
                        <Button size="small" onClick={() => setDrawer([r])}>
                          Pack
                        </Button>
                      ) : null,
                  },
                ]
              : []),
          ]}
        />
      </Card>

      <Card size="small" title="Packed cartons" style={{ marginTop: 16 }}>
        <Table
          size="small"
          rowKey="id"
          dataSource={batches}
          pagination={{ pageSize: 12, hideOnSinglePage: true }}
          columns={[
            { title: 'Packed', dataIndex: 'packedOn', width: 110, render: (v: string) => dayjs(v).format('DD MMM YYYY') },
            { title: 'Product', render: (_, r) => `${r.productCode} — ${r.productName}` },
            {
              title: 'Order',
              render: (_, r) => (r.orderId ? <Link to={`/operations/orders/${r.orderId}`}>{r.orderNumber}</Link> : <Tag color="blue">Free pool</Tag>),
            },
            { title: 'Pcs', dataIndex: 'qty', align: 'right' as const, width: 60 },
            { title: 'Cartons', dataIndex: 'cartonCount', align: 'right' as const, width: 70 },
            {
              title: 'CBM / carton',
              align: 'right' as const,
              width: 130,
              render: (_, r) => (
                <Space size={4}>
                  <span>{r.cbmPerCarton.toFixed(4)}</span>
                  {/* Where the figure came from, so a printed CBM is always explained. */}
                  <Tag color={r.cbmSource === 'OVERRIDE' ? 'purple' : r.cbmSource === 'STORED' ? 'blue' : 'default'} style={{ marginInlineEnd: 0 }}>
                    {r.cbmSource === 'OVERRIDE' ? 'measured' : r.cbmSource === 'STORED' ? 'from product' : 'from dims'}
                  </Tag>
                </Space>
              ),
            },
            { title: 'Total CBM', dataIndex: 'totalCbm', align: 'right' as const, width: 90, render: (v: number) => v.toFixed(3) },
            { title: 'Gross kg', dataIndex: 'totalGrossKg', align: 'right' as const, width: 90 },
            { title: 'Marks', dataIndex: 'shippingMarks', ellipsis: true },
            {
              title: 'Shipped',
              width: 130,
              render: (_, r) =>
                r.shippedCartons > 0 ? (
                  <Space size={2} wrap>
                    {r.shipments.map((s) => (
                      <Link key={s.shipmentId} to={`/sales/shipments/${s.shipmentId}`}>
                        <Tag color="processing">{s.number}</Tag>
                      </Link>
                    ))}
                  </Space>
                ) : (
                  <Tag>on the floor</Tag>
                ),
            },
            ...(canPack
              ? [
                  {
                    title: '',
                    width: 80,
                    render: (_: unknown, r: { id: number; availableCartons: number; cartonCount: number }) =>
                      // Hidden rather than disabled once cartons are on a shipment: the server
                      // refuses it anyway, and a button that always fails is noise.
                      r.availableCartons === r.cartonCount ? (
                        <Popconfirm title="Unpack this batch?" description="The pieces go back to being unpacked." onConfirm={() => unpack.mutate(r.id)}>
                          <Button size="small" type="text" danger>
                            Unpack
                          </Button>
                        </Popconfirm>
                      ) : null,
                  },
                ]
              : []),
          ]}
        />
      </Card>

      {drawer && <PackDrawer rows={drawer} onClose={() => setDrawer(null)} />}
    </div>
  );
}
