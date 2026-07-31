import { useMemo, useState } from 'react';
import TrashDrawer, { TrashButton } from '../../components/TrashDrawer';
import { App, Breadcrumb, Button, Card, Form, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import { HomeOutlined, PlusOutlined, EyeOutlined, DeleteOutlined, ShopOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ColumnsType } from 'antd/es/table';
import { api, apiError } from '../../api/client';
import { useOrders, useSheets, type MaterialSheet } from '../../api/ops';
import { useProducts } from '../../api/hooks';
import { useAuth } from '../../auth/AuthContext';

const { Title, Text } = Typography;

/**
 * Material sheets: the printout of what a job needs. Production progress is not
 * here — it lives on the order board.
 */
export default function SheetsPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { data, isLoading } = useSheets();
  const { data: products } = useProducts({});
  const { data: orders } = useOrders();
  const [form] = Form.useForm();
  const [open, setOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: ['op-sheets'] });

  const create = useMutation({
    mutationFn: (v: any) => api.post('/operation-sheets', v),
    onSuccess: (res) => {
      const sheet = res.data as MaterialSheet;
      message.success(sheet.existing ? `Sheet ${sheet.number} already exists.` : `Sheet ${sheet.number} created.`);
      setOpen(false);
      form.resetFields();
      refresh();
      navigate(`/operations/sheets/${sheet.id}`);
    },
    onError: (e) => message.error(apiError(e)),
  });

  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/operation-sheets/${id}`),
    onSuccess: () => {
      message.success('Sheet deleted.');
      refresh();
      qc.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (e) => message.error(apiError(e)),
  });

  const groups = useMemo(() => {
    const map = new Map<string, { orderId?: number; orderNumber?: string; buyer?: string; sheets: MaterialSheet[] }>();
    for (const s of data ?? []) {
      const key = s.order ? String(s.order.id) : 'none';
      if (!map.has(key)) map.set(key, { orderId: s.order?.id, orderNumber: s.order?.number, buyer: s.order?.buyer?.name, sheets: [] });
      map.get(key)!.sheets.push(s);
    }
    return Array.from(map.values());
  }, [data]);

  const cols: ColumnsType<MaterialSheet> = [
    { title: 'Sheet', dataIndex: 'number', width: 120, render: (n, r) => <Link to={`/operations/sheets/${r.id}`} style={{ fontWeight: 600 }}>{n}</Link> },
    { title: 'Product', key: 'product', render: (_, r) => `${r.product.factoryCode} — ${r.product.name}` },
    { title: 'Qty', dataIndex: 'qty', width: 90, align: 'right', render: (v, r) => `${v} ${r.product.unit?.code ?? 'pcs'}` },
    {
      title: 'Made by',
      key: 'mode',
      width: 220,
      render: (_, r) => {
        if (!r.orderLine) return <Text type="secondary">—</Text>;
        const vendors = [...new Map((r.orderLine.stages ?? []).filter((s) => s.vendor).map((s) => [s.vendor!.id, s.vendor!.name])).values()];
        if (vendors.length === 0) return <Tag>In-house</Tag>;
        return (
          <Space size={4} wrap>
            {vendors.map((name) => (
              <Tag key={name} color="volcano" icon={<ShopOutlined />}>
                {name}
              </Tag>
            ))}
            {vendors.length < (r.orderLine.stages ?? []).length && <Tag>+ in-house</Tag>}
          </Space>
        );
      },
    },
    {
      title: '',
      key: 'a',
      width: 90,
      render: (_, r) => (
        <Space>
          <Button size="small" icon={<EyeOutlined />} onClick={() => navigate(`/operations/sheets/${r.id}`)} />
          {can('sheets.delete') && (
            <Popconfirm title="Delete this sheet?" onConfirm={() => del.mutate(r.id)} okButtonProps={{ danger: true }}>
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Breadcrumb style={{ marginBottom: 16 }} items={[{ title: <Link to="/"><HomeOutlined /></Link> }, { title: <Link to="/operations">Operations</Link> }, { title: 'Material Sheets' }]} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>
            Material Sheets
          </Title>
          <Text type="secondary">What a job needs — wood, hardware, polish, packing, labour — exploded from the product costing and printable per section.</Text>
        </div>
        <Space>
          {can('sheets.restore') && <TrashButton endpoint="/operation-sheets" onClick={() => setTrashOpen(true)} />}
          {can('sheets.create') && (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              form.resetFields();
              form.setFieldsValue({ qty: 1 });
              setOpen(true);
            }}
          >
            New Sheet
          </Button>
          )}
        </Space>
      </div>

      {isLoading ? (
        <Card loading />
      ) : groups.length === 0 ? (
        <Card>
          <Text type="secondary">No material sheets yet. Create one from an order line on the board, or add a standalone sheet here.</Text>
        </Card>
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {groups.map((g, i) => (
            <Card
              key={i}
              size="small"
              title={
                <Space>
                  {g.orderNumber ? <Link to={`/operations/orders/${g.orderId}`}>{g.orderNumber}</Link> : <Text type="secondary">Standalone sheets</Text>}
                  {g.buyer && <Text type="secondary">{g.buyer}</Text>}
                  <Tag>{g.sheets.length} sheet(s)</Tag>
                </Space>
              }
            >
              <Table<MaterialSheet> rowKey="id" size="small" columns={cols} dataSource={g.sheets} pagination={false} scroll={{ x: 640 }} />
            </Card>
          ))}
        </Space>
      )}

      <Modal title="New material sheet" open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()} confirmLoading={create.isPending} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={(v) => create.mutate(v)} style={{ marginTop: 12 }}>
          <Form.Item name="productId" label="Product" rules={[{ required: true, message: 'Pick a product.' }]}>
            <Select showSearch optionFilterProp="label" options={(products ?? []).map((p) => ({ label: `${p.factoryCode} — ${p.name}`, value: p.id }))} />
          </Form.Item>
          <Form.Item name="qty" label="Quantity (pieces)" rules={[{ required: true, message: 'How many pieces?' }]}>
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="orderId" label="Link to order (optional)">
            <Select allowClear showSearch optionFilterProp="label" options={(orders ?? []).map((o) => ({ label: `${o.number} — ${o.buyer.name}`, value: o.id }))} />
          </Form.Item>
        </Form>
      </Modal>
      <TrashDrawer
        open={trashOpen}
        onClose={() => setTrashOpen(false)}
        title="Deleted material sheets"
        endpoint="/operation-sheets"
        label="Material sheet"
        queryKeys={[['sheets'], ['ops-dashboard']]}
        columns={[
          { title: 'Sheet', width: 130, render: (r) => <b>{String(r.number)}</b> },
          { title: 'Product', render: (r) => String((r.product as { factoryCode?: string } | undefined)?.factoryCode ?? '—') },
          { title: 'Qty', width: 70, render: (r) => String(r.qty) },
        ]}
      />
    </div>
  );
}
