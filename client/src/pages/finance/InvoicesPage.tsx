import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App, Breadcrumb, Button, Card, Popconfirm, Result, Segmented, Space, Table, Tag, Typography } from 'antd';
import { HomeOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { deleteInvoice, invalidateSales, INVOICE_STATUS_COLOR, SALES_KEYS, useInvoices } from '../../api/sales';
import { OPS_KEYS } from '../../api/ops';
import { apiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import TrashDrawer, { TrashButton } from '../../components/TrashDrawer';
import { money } from '../../util/format';

const { Title, Text } = Typography;

const FILTERS = ['All', 'DRAFT', 'ISSUED', 'CANCELLED'] as const;

export default function InvoicesPage() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { can } = useAuth();
  const [filter, setFilter] = useState<string>('All');
  const [trash, setTrash] = useState(false);
  const { data: rows = [], isLoading } = useInvoices(filter);

  // Before the role guard below: React counts hooks by position, so a `useMutation` after a
  // conditional `return` changes the hook order between renders and white-screens the page.
  const remove = useMutation({
    mutationFn: deleteInvoice,
    onSuccess: () => {
      message.success('Moved to the trash.');
      invalidateSales(qc);
    },
    onError: (e) => message.error(apiError(e)),
  });

  if (!can('invoices.view')) return <Result status="403" title="No access to invoices" subTitle='This needs the "See invoices" permission.' />;

  return (
    <div>
      <Breadcrumb
        style={{ marginBottom: 12 }}
        items={[{ title: <Link to="/"><HomeOutlined /></Link> }, { title: <Link to="/finance">Finance</Link> }, { title: 'Invoices' }]}
      />
      <Space style={{ justifyContent: 'space-between', width: '100%', marginBottom: 12 }}>
        <Title level={4} style={{ margin: 0 }}>
          Invoices
        </Title>
        <TrashButton endpoint="/invoices" onClick={() => setTrash(true)} />
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
              title: 'Invoice',
              render: (_, i) => (
                <Link to={`/finance/invoices/${i.id}`} style={{ fontWeight: 600 }}>
                  {i.number}
                </Link>
              ),
            },
            { title: 'Date', dataIndex: 'invoiceDate', width: 110, render: (v: string) => dayjs(v).format('DD MMM YYYY') },
            {
              title: 'Buyer',
              render: (_, i) => (
                <Space size={4}>
                  <span>{i.buyer.name}</span>
                  {(i.taxMarket ?? i.buyer.market) === 'DOMESTIC' ? <Tag color="gold">Domestic</Tag> : <Tag color="cyan">Export</Tag>}
                </Space>
              ),
            },
            {
              title: 'Orders',
              render: (_, i) => (
                <Space size={2} wrap>
                  {i.orders.map((o) => (
                    <Link key={o.orderId} to={`/operations/orders/${o.orderId}`}>
                      <Tag>{o.number}</Tag>
                    </Link>
                  ))}
                </Space>
              ),
            },
            {
              title: 'Shipment',
              width: 110,
              render: (_, i) => (i.shipment ? <Link to={`/sales/shipments/${i.shipment.id}`}>{i.shipment.number}</Link> : '—'),
            },
            { title: 'Taxable', align: 'right' as const, width: 110, render: (_, i) => money(i.totals.taxableValue, i.currency?.symbol ?? '₹') },
            { title: 'Tax', align: 'right' as const, width: 100, render: (_, i) => money(i.totals.taxTotal, i.currency?.symbol ?? '₹') },
            {
              title: 'Total',
              align: 'right' as const,
              width: 130,
              render: (_, i) => <b>{money(i.totals.grandTotal, i.currency?.symbol ?? '₹')}</b>,
            },
            { title: 'Status', dataIndex: 'status', width: 100, render: (v: string) => <Tag color={INVOICE_STATUS_COLOR[v] ?? 'default'}>{v}</Tag> },
            {
              title: '',
              width: 70,
              render: (_, i) => (
                <Popconfirm title="Move to the trash?" description="It leaves every money total and can be restored." onConfirm={() => remove.mutate(i.id)}>
                  <Button size="small" type="text" danger>
                    Delete
                  </Button>
                </Popconfirm>
              ),
            },
          ]}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          Only an <b>issued</b> invoice is money owed — a draft has not been sent to anybody.
        </Text>
      </Card>

      <TrashDrawer
        open={trash}
        onClose={() => setTrash(false)}
        title="Deleted invoices"
        endpoint="/invoices"
        label="Invoice"
        queryKeys={[...SALES_KEYS, ...OPS_KEYS]}
        columns={[
          { title: 'Invoice', width: 160, render: (r) => <b>{String(r.number)}</b> },
          { title: 'Buyer', render: (r) => String((r.buyer as { name?: string } | undefined)?.name ?? '—') },
          { title: 'Status', width: 110, render: (r) => <Tag>{String(r.status)}</Tag> },
        ]}
      />
    </div>
  );
}
