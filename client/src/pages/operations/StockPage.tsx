import { useMemo, useState } from 'react';
import { Breadcrumb, Button, Card, Col, Collapse, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Table, Tag, Tooltip, Typography, App } from 'antd';
import { HomeOutlined, PlusOutlined, ImportOutlined, ExportOutlined, DeleteOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { api, apiError } from '../../api/client';
import { useRawItems, useStockTxns, useSuppliers, type RawItem, type StockTxn } from '../../api/ops';
import { num } from '../../util/format';
import { useAuth } from '../../auth/AuthContext';
import { RateHint } from '../../components/HistoryHint';

const { Title, Text } = Typography;

export default function StockPage() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { data: items, isLoading } = useRawItems();
  const { data: txns } = useStockTxns();
  const { data: suppliers } = useSuppliers('MATERIAL');
  // Same bar the server sets on the route, so nobody is shown a button that will 403.
  const canEditStock = useAuth().hasRole('Operator');

  const itemGroups = useMemo(() => {
    const map = new Map<string, RawItem[]>();
    for (const it of items ?? []) {
      const k = it.category || 'Uncategorised';
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(it);
    }
    return Array.from(map.entries()).map(([key, rows]) => ({ key, rows }));
  }, [items]);

  const [itemForm] = Form.useForm();
  const [itemOpen, setItemOpen] = useState(false);
  const [editItem, setEditItem] = useState<RawItem | null>(null);

  const [moveForm] = Form.useForm();
  // Watched so the rate hint follows the item and supplier as they are picked.
  const moveWatch = {
    rawItemId: Form.useWatch('rawItemId', moveForm) as number | undefined,
    supplierId: Form.useWatch('supplierId', moveForm) as number | undefined,
    rate: Form.useWatch('rate', moveForm) as number | undefined,
  };
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveType, setMoveType] = useState<'IN' | 'OUT'>('IN');

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['raw-items'] });
    qc.invalidateQueries({ queryKey: ['stock-txns'] });
  };

  const saveItem = useMutation({
    mutationFn: (v: any) => (editItem ? api.patch(`/raw-items/${editItem.id}`, v) : api.post('/raw-items', v)),
    onSuccess: () => { message.success('Saved.'); setItemOpen(false); setEditItem(null); itemForm.resetFields(); refresh(); },
    onError: (e) => message.error(apiError(e)),
  });

  const saveMove = useMutation({
    mutationFn: (v: any) => api.post('/stock/txns', { ...v, type: moveType, date: v.date ? v.date.toISOString() : undefined }),
    onSuccess: () => { message.success('Recorded.'); setMoveOpen(false); moveForm.resetFields(); refresh(); },
    onError: (e) => message.error(apiError(e)),
  });

  /**
   * A stock movement is typed by hand, so a wrong quantity or rate has to be removable —
   * there is no edit, and without this the only record of a mistake stayed on the
   * supplier's statement forever. The server refuses when the receipt has already been
   * billed, or when removing it would drive the balance negative, and says which; this
   * only has to surface that answer.
   */
  const delMove = useMutation({
    mutationFn: (id: number) => api.delete(`/stock/txns/${id}`),
    onSuccess: () => { message.success('Movement removed.'); refresh(); },
    onError: (e) => message.error(apiError(e)),
  });

  const openItemNew = () => { setEditItem(null); itemForm.resetFields(); itemForm.setFieldsValue({ unit: 'PCS', reorderLevel: 0, openingQty: 0 }); setItemOpen(true); };
  const openItemEdit = (it: RawItem) => { setEditItem(it); itemForm.setFieldsValue(it); setItemOpen(true); };
  const openMove = (type: 'IN' | 'OUT', rawItemId?: number) => { setMoveType(type); moveForm.resetFields(); moveForm.setFieldsValue({ rawItemId, date: dayjs() }); setMoveOpen(true); };

  const itemCols: ColumnsType<RawItem> = [
    { title: 'Code', dataIndex: 'code', width: 110, render: (c) => <b>{c}</b> },
    { title: 'Item', dataIndex: 'name' },
    { title: 'Category', dataIndex: 'category', render: (v) => v || '—' },
    { title: 'Unit', dataIndex: 'unit', width: 70 },
    { title: 'In', dataIndex: 'inQty', align: 'right', render: (v) => num(v, 2) },
    { title: 'Out', dataIndex: 'outQty', align: 'right', render: (v) => num(v, 2) },
    { title: 'Balance', dataIndex: 'balance', align: 'right', render: (v, r) => <b style={{ color: r.low ? '#cf1322' : undefined }}>{num(v, 2)}</b> },
    { title: 'Reorder', dataIndex: 'reorderLevel', align: 'right', render: (v) => num(v, 2) },
    { title: '', key: 'low', width: 80, render: (_, r) => (r.low ? <Tag color="red">LOW</Tag> : null) },
    {
      title: 'Actions', key: 'a', width: 170,
      render: (_, r) => (
        <Space>
          <Button size="small" icon={<ImportOutlined />} onClick={() => openMove('IN', r.id)}>In</Button>
          <Button size="small" icon={<ExportOutlined />} onClick={() => openMove('OUT', r.id)}>Out</Button>
          <Button size="small" onClick={() => openItemEdit(r)}>Edit</Button>
        </Space>
      ),
    },
  ];

  const txnCols: ColumnsType<StockTxn> = [
    { title: 'Date', dataIndex: 'date', width: 110, render: (d) => dayjs(d).format('DD MMM YY') },
    { title: 'Item', dataIndex: ['rawItem', 'name'] },
    { title: 'Type', dataIndex: 'type', width: 70, render: (t) => <Tag color={t === 'IN' ? 'green' : 'volcano'}>{t}</Tag> },
    { title: 'Qty', dataIndex: 'qty', align: 'right', render: (v, r) => `${num(v, 2)} ${r.rawItem?.unit ?? ''}` },
    { title: 'Rate', dataIndex: 'rate', align: 'right', render: (v) => (v ? `₹${num(v, 2)}` : '—') },
    { title: 'Supplier', dataIndex: ['supplier', 'name'], render: (v) => v || '—' },
    { title: 'Order Ref', dataIndex: 'orderRef', render: (v) => v || '—' },
    { title: 'Note', dataIndex: 'note', render: (v) => v || '—' },
    {
      title: '',
      key: 'x',
      width: 60,
      render: (_, r) =>
        canEditStock ? (
          <Popconfirm
            title="Remove this movement?"
            description="The stock balance goes back to what it was. A receipt that has already been billed cannot be removed."
            okText="Remove"
            okButtonProps={{ danger: true }}
            onConfirm={() => delMove.mutate(r.id)}
          >
            <Tooltip title="Remove this movement">
              <Button size="small" danger type="text" aria-label="Remove this stock movement" icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        ) : null,
    },
  ];

  return (
    <div>
      <Breadcrumb style={{ marginBottom: 16 }} items={[{ title: <Link to="/"><HomeOutlined /></Link> }, { title: <Link to="/operations">Operations</Link> }, { title: 'Stock' }]} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div><Title level={3} style={{ margin: 0 }}>Stock</Title><Text type="secondary">Raw-material balances & movements. Independent of orders — outward can just reference an order number.</Text></div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openItemNew}>Add Item</Button>
      </div>

      <Collapse defaultActiveKey={itemGroups.map((g) => g.key)} style={{ marginBottom: 16 }} items={itemGroups.map((g) => ({
        key: g.key,
        label: <span><b>{g.key}</b> <Tag style={{ marginLeft: 6 }}>{g.rows.length}</Tag>{g.rows.some((r) => r.low) && <Tag color="red">low stock</Tag>}</span>,
        children: <Table<RawItem> rowKey="id" size="small" loading={isLoading} columns={itemCols} dataSource={g.rows} pagination={false} scroll={{ x: 900 }} />,
      }))} />

      <Card size="small" title="Recent movements">
        <Table<StockTxn> rowKey="id" size="small" columns={txnCols} dataSource={txns ?? []} pagination={{ pageSize: 10 }} scroll={{ x: 800 }} />
      </Card>

      {/* Item modal */}
      <Modal title={editItem ? 'Edit item' : 'Add raw item'} open={itemOpen} onCancel={() => setItemOpen(false)} onOk={() => itemForm.submit()} confirmLoading={saveItem.isPending} destroyOnHidden>
        <Form form={itemForm} layout="vertical" onFinish={(v) => saveItem.mutate(v)} style={{ marginTop: 12 }}>
          <Row gutter={12}>
            <Col span={10}><Form.Item name="code" label="Code" rules={[{ required: true }]}><Input disabled={!!editItem} /></Form.Item></Col>
            <Col span={14}><Form.Item name="name" label="Name" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col span={10}><Form.Item name="category" label="Category"><Input /></Form.Item></Col>
            <Col span={6}><Form.Item name="unit" label="Unit" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="reorderLevel" label="Reorder level"><InputNumber style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="openingQty" label="Opening qty"><InputNumber style={{ width: '100%' }} /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>

      {/* Movement modal */}
      <Modal title={`Record ${moveType === 'IN' ? 'Inward' : 'Outward'}`} open={moveOpen} onCancel={() => setMoveOpen(false)} onOk={() => moveForm.submit()} confirmLoading={saveMove.isPending} destroyOnHidden>
        <Form form={moveForm} layout="vertical" onFinish={(v) => saveMove.mutate(v)} style={{ marginTop: 12 }}>
          <Form.Item name="rawItemId" label="Item" rules={[{ required: true }]}>
            <Select showSearch optionFilterProp="label" options={(items ?? []).map((i) => ({ label: `${i.code} — ${i.name} (bal ${num(i.balance, 2)} ${i.unit})`, value: i.id }))} />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="qty" label="Quantity" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} min={0.001} /></Form.Item></Col>
            <Col span={12}><Form.Item name="date" label="Date"><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
          </Row>
          {moveType === 'IN' ? (
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item
                  name="rate"
                  label="Rate (₹/unit)"
                  /* What this supplier, then anyone, has billed for it before — and
                     what it is costed at inside product sheets. */
                  extra={
                    <RateHint
                      compact={false}
                      kind="PURCHASE"
                      rawItemId={moveWatch.rawItemId}
                      supplierId={moveWatch.supplierId}
                      value={moveWatch.rate}
                      unitSuffix={`/${items?.find((i) => i.id === moveWatch.rawItemId)?.unit ?? 'unit'}`}
                      onApply={(v) => moveForm.setFieldsValue({ rate: v })}
                    />
                  }
                >
                  <InputNumber style={{ width: '100%' }} min={0} />
                </Form.Item>
              </Col>
              <Col span={12}><Form.Item name="supplierId" label="Supplier"><Select allowClear options={(suppliers ?? []).map((s) => ({ label: s.name, value: s.id }))} /></Form.Item></Col>
            </Row>
          ) : (
            <Form.Item name="orderRef" label="Order reference (optional)"><Input placeholder="e.g. ORD-2026-0001" /></Form.Item>
          )}
          <Form.Item name="note" label="Note"><Input /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
