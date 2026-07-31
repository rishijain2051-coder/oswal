import { useMemo, useState } from 'react';
import TrashDrawer, { TrashButton } from '../../components/TrashDrawer';
import { App, Breadcrumb, Button, Card, Popconfirm, Segmented, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { HomeOutlined, PlusOutlined, EyeOutlined, EditOutlined, DeleteOutlined, FilePdfOutlined, MailOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { api, apiError } from '../../api/client';
import { fetchDocument, useProformas, PROFORMA_STATUS_COLOR, type Proforma } from '../../api/ops';
import { useAuth } from '../../auth/AuthContext';
import { money } from '../../util/format';

const { Title, Text } = Typography;

/** Re-exported for pages that only need the colour map. */
export { PROFORMA_STATUS_COLOR };

const FILTERS = ['All', 'Draft', 'Sent', 'Accepted', 'Rejected'] as const;

export default function ProformasPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [trashOpen, setTrashOpen] = useState(false);
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { data, isLoading } = useProformas();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('All');

  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/proformas/${id}`),
    onSuccess: () => {
      message.success('Proforma deleted.');
      qc.invalidateQueries({ queryKey: ['proformas'] });
      qc.invalidateQueries({ queryKey: ['ops-dashboard'] });
    },
    onError: (e) => message.error(apiError(e)),
  });

  const rows = useMemo(() => (filter === 'All' ? data ?? [] : (data ?? []).filter((p) => p.status === filter)), [data, filter]);
  const waiting = (data ?? []).filter((p) => p.status === 'Sent').length;

  const columns: ColumnsType<Proforma> = [
    { title: 'PI No.', dataIndex: 'number', width: 150, render: (n, r) => <Link to={`/operations/proformas/${r.id}`} style={{ fontWeight: 600 }}>{n}</Link> },
    {
      title: 'Buyer',
      dataIndex: ['buyer', 'name'],
      render: (v, r) => (
        <Space size={4} wrap>
          {v}
          {/* The market explains the currency, and why some quotes carry GST. */}
          <Tag color={r.buyer.market === 'DOMESTIC' ? 'geekblue' : 'gold'} style={{ marginInlineEnd: 0 }}>
            {r.buyer.market === 'DOMESTIC' ? 'Domestic' : 'Overseas'}
          </Tag>
          {r.buyer.channel === 'B2C' && <Tag style={{ marginInlineEnd: 0 }}>B2C</Tag>}
          {!r.buyer.email && (
            <Tooltip title="No e-mail on this buyer — add one to send by mail">
              <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                no e-mail
              </Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    { title: 'Date', dataIndex: 'date', width: 105, render: (d) => dayjs(d).format('DD MMM YY') },
    { title: 'Items', key: 'items', width: 70, align: 'right', render: (_, r) => r.lines.length },
    { title: 'Total', dataIndex: 'total', align: 'right', width: 130, render: (v, r) => money(v, r.currency?.symbol ?? '₹') },
    { title: 'Order', dataIndex: 'order', width: 130, render: (o: Proforma['order']) => (o ? <Link to={`/operations/orders/${o.id}`}>{o.number}</Link> : '—') },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 110,
      render: (s, r) => (
        <Tooltip title={r.status === 'Rejected' && r.rejectReason ? r.rejectReason : undefined}>
          <Tag color={PROFORMA_STATUS_COLOR[s] ?? 'default'}>{s}</Tag>
        </Tooltip>
      ),
    },
    {
      title: '',
      key: 'a',
      width: 160,
      render: (_, r) => (
        <Space>
          <Tooltip title="Open this proforma">
            <Button size="small" aria-label="Open this proforma" icon={<EyeOutlined />} onClick={() => navigate(`/operations/proformas/${r.id}`)} />
          </Tooltip>
          <Tooltip title="Download the PDF">
            <Button size="small" aria-label="Download this proforma as a PDF" icon={<FilePdfOutlined />} onClick={() => fetchDocument(`/proformas/${r.id}/pdf`, `${r.number}.pdf`, true).catch((e) => message.error(e.message))} />
          </Tooltip>
          {can('proformas.accept') && !r.order && (
            <Tooltip title="Send to buyer">
              <Button size="small" aria-label="Send this proforma to the buyer" icon={<MailOutlined />} onClick={() => navigate(`/operations/proformas/${r.id}`)} />
            </Tooltip>
          )}
          {can('proformas.edit') && r.canEdit && (
            <Tooltip title="Edit this proforma">
              <Button size="small" aria-label="Edit this proforma" icon={<EditOutlined />} onClick={() => navigate(`/operations/proformas/${r.id}/edit`)} />
            </Tooltip>
          )}
          {can('proformas.delete') && !r.order && (
            <Popconfirm title="Delete this proforma?" onConfirm={() => del.mutate(r.id)} okButtonProps={{ danger: true }}>
              <Tooltip title="Move to trash">
                <Button size="small" danger aria-label="Move this proforma to the trash" icon={<DeleteOutlined />} />
              </Tooltip>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Breadcrumb style={{ marginBottom: 16 }} items={[{ title: <Link to="/"><HomeOutlined /></Link> }, { title: <Link to="/operations">Operations</Link> }, { title: 'Proformas' }]} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>
            Proformas
          </Title>
          <Text type="secondary">
            Make it, send it, then record the buyer's answer.
            {waiting > 0 ? ` ${waiting} waiting on a reply.` : ''}
          </Text>
        </div>
        <Space>
          {can('proformas.restore') && <TrashButton endpoint="/proformas" onClick={() => setTrashOpen(true)} />}
          {can('proformas.create') && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/operations/proformas/new')}>
              New Proforma
            </Button>
          )}
        </Space>
      </div>
      <Card size="small">
        <Segmented style={{ marginBottom: 12 }} value={filter} onChange={(v) => setFilter(v as (typeof FILTERS)[number])} options={FILTERS as unknown as string[]} />
        <Table<Proforma> rowKey="id" size="small" loading={isLoading} columns={columns} dataSource={rows} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 1000 }} />
      </Card>
      <TrashDrawer
        open={trashOpen}
        onClose={() => setTrashOpen(false)}
        title="Deleted proformas"
        endpoint="/proformas"
        label="Proforma"
        queryKeys={[['proformas'], ['ops-dashboard']]}
        columns={[
          { title: 'Number', width: 150, render: (r) => <b>{String(r.number)}</b> },
          { title: 'Buyer', render: (r) => String((r.buyer as { name?: string } | undefined)?.name ?? '—') },
          { title: 'Status', width: 110, render: (r) => <Tag>{String(r.status)}</Tag> },
        ]}
      />
    </div>
  );
}
