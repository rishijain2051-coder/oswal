import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Breadcrumb, Button, Card, Popconfirm, Result, Segmented, Space, Table, Tag, Tooltip, Typography, message } from 'antd';
import { HomeOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { deleteShipment, invalidateSales, SALES_KEYS, SHIPMENT_STATUS_COLOR, useShipments, type Shipment } from '../../api/sales';
import { OPS_KEYS } from '../../api/ops';
import { apiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import TrashDrawer, { TrashButton } from '../../components/TrashDrawer';

const { Title, Text } = Typography;

const FILTERS = ['All', 'PLANNED', 'LOADED', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const;

export default function ShipmentsPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { hasRole } = useAuth();
  const [filter, setFilter] = useState<string>('All');
  const [trash, setTrash] = useState(false);
  const { data: rows = [], isLoading } = useShipments(filter);

  // Before the role guard below: React counts hooks by position, so a `useMutation` after a
  // conditional `return` changes the hook order between renders and white-screens the page.
  const remove = useMutation({
    mutationFn: deleteShipment,
    onSuccess: (r: { note?: string }) => {
      message.success(r?.note ?? 'Moved to the trash.');
      invalidateSales(qc);
    },
    onError: (e) => message.error(apiError(e)),
  });

  // Gated in the sidebar too, so this only catches somebody typing the URL.
  if (!hasRole('Manager')) {
    return <Result status="403" title="Manager access" subTitle="Dispatch and invoicing are Manager and above." />;
  }

  return (
    <div>
      <Breadcrumb
        style={{ marginBottom: 12 }}
        items={[{ title: <Link to="/"><HomeOutlined /></Link> }, { title: <Link to="/sales">Dispatch</Link> }, { title: 'Shipments' }]}
      />
      <Space style={{ justifyContent: 'space-between', width: '100%', marginBottom: 12 }}>
        <Title level={4} style={{ margin: 0 }}>
          Shipments
        </Title>
        <Space>
          <TrashButton endpoint="/shipments" onClick={() => setTrash(true)} />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => nav('/sales/shipments/new')}>
            New shipment
          </Button>
        </Space>
      </Space>

      <Card size="small" styles={{ body: { paddingTop: 8 } }}>
        <Segmented options={FILTERS as unknown as string[]} value={filter} onChange={(v) => setFilter(String(v))} style={{ marginBottom: 10 }} />
        <Table
          size="small"
          rowKey="id"
          loading={isLoading}
          dataSource={rows}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          columns={[
            {
              title: 'Shipment',
              render: (_, s) => (
                <Link to={`/sales/shipments/${s.id}`} style={{ fontWeight: 600 }}>
                  {s.number}
                </Link>
              ),
            },
            { title: 'Date', dataIndex: 'shipDate', width: 110, render: (v: string | null) => (v ? dayjs(v).format('DD MMM YYYY') : '—') },
            {
              // Multi-buyer and multi-order are the default here, not an exception.
              title: 'Buyers',
              render: (_, s) => (
                <Space size={2} wrap>
                  {[...new Set(s.orders.map((o) => o.buyerName))].map((b) => (
                    <Tag key={b}>{b}</Tag>
                  ))}
                </Space>
              ),
            },
            {
              title: 'Orders',
              render: (_, s) => (
                <Space size={2} wrap>
                  {s.orders.map((o) => (
                    <Link key={o.orderId} to={`/operations/orders/${o.orderId}`}>
                      <Tag color="default">{o.number}</Tag>
                    </Link>
                  ))}
                </Space>
              ),
            },
            { title: 'Cartons', align: 'right' as const, width: 80, render: (_, s) => s.totals.cartons },
            { title: 'CBM', align: 'right' as const, width: 80, render: (_, s) => s.totals.cbm.toFixed(3) },
            { title: 'Gross kg', align: 'right' as const, width: 90, render: (_, s) => s.totals.grossKg.toFixed(0) },
            {
              title: 'Containers',
              width: 130,
              render: (_, s) => (
                <Space size={2} wrap>
                  {s.containers.map((c) => (
                    <Tooltip key={c.id} title={`${c.fit.cbmPct.toFixed(0)}% by volume, ${c.fit.kgPct.toFixed(0)}% by weight`}>
                      <Tag color={c.fit.fits ? 'default' : 'red'}>{c.containerNo || c.code}</Tag>
                    </Tooltip>
                  ))}
                  {s.unassigned.cartons > 0 && <Tag color="orange">{s.unassigned.cartons} loose</Tag>}
                </Space>
              ),
            },
            {
              title: 'Invoice',
              width: 130,
              render: (_, s) =>
                s.invoices.length ? (
                  <Space size={2} wrap>
                    {s.invoices.map((v) => (
                      <Link key={v.id} to={`/finance/invoices/${v.id}`}>
                        <Tag color={v.status === 'ISSUED' ? 'green' : 'default'}>{v.number}</Tag>
                      </Link>
                    ))}
                  </Space>
                ) : (
                  <Tag>not invoiced</Tag>
                ),
            },
            { title: 'Status', dataIndex: 'status', width: 110, render: (v: string) => <Tag color={SHIPMENT_STATUS_COLOR[v] ?? 'default'}>{v}</Tag> },
            {
              title: '',
              width: 100,
              render: (_, s: Shipment) => {
                const invoiced = s.invoices.some((v) => v.status !== 'CANCELLED');
                return (
                  <Space size={4}>
                    <Button size="small" type="text" onClick={() => nav(`/sales/shipments/${s.id}/edit`)} disabled={invoiced}>
                      Edit
                    </Button>
                    {/* Disabled rather than hidden, because the tooltip explains WHY. */}
                    {invoiced ? (
                      <Tooltip title={`${s.invoices.map((v) => v.number).join(', ')} has been raised against this shipment. Cancel the invoice first.`}>
                        <Button size="small" type="text" danger disabled>
                          Delete
                        </Button>
                      </Tooltip>
                    ) : (
                      <Popconfirm
                        title="Move to the trash?"
                        description="The cartons become available again and the order status is restated."
                        onConfirm={() => remove.mutate(s.id)}
                      >
                        <Button size="small" type="text" danger>
                          Delete
                        </Button>
                      </Popconfirm>
                    )}
                  </Space>
                );
              },
            },
          ]}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          Cartons, volume and weight are worked out from the packing data — there is nothing to type.
        </Text>
      </Card>

      <TrashDrawer
        open={trash}
        onClose={() => setTrash(false)}
        title="Deleted shipments"
        endpoint="/shipments"
        label="Shipment"
        queryKeys={[...SALES_KEYS, ...OPS_KEYS]}
        columns={[
          { title: 'Shipment', width: 150, render: (r) => <b>{String(r.number)}</b> },
          { title: 'Status', width: 110, render: (r) => <Tag>{String(r.status)}</Tag> },
        ]}
      />
    </div>
  );
}
