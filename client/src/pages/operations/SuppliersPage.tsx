import { useMemo, useState } from 'react';
import { Breadcrumb, Button, Card, Col, Collapse, Form, Input, Modal, Popconfirm, Row, Select, Space, Switch, Table, Tag, Tooltip, Typography, App } from 'antd';
import { HomeOutlined, PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ColumnsType } from 'antd/es/table';
import { api, apiError } from '../../api/client';
import { useSuppliers, type Supplier } from '../../api/ops';
import { useAuth } from '../../auth/AuthContext';

const { Title, Text } = Typography;
const GROUPS: { key: string; label: string; match: string[] }[] = [
  { key: 'MATERIAL', label: 'Material suppliers', match: ['MATERIAL', 'BOTH'] },
  { key: 'JOBWORK', label: 'Jobwork vendors', match: ['JOBWORK', 'BOTH'] },
];

export default function SuppliersPage() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { can } = useAuth();
  const { data: suppliers, isLoading } = useSuppliers();
  const [form] = Form.useForm();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Supplier | null>(null);

  const save = useMutation({
    mutationFn: (v: any) => (editing ? api.patch(`/suppliers/${editing.id}`, v) : api.post('/suppliers', v)),
    onSuccess: () => { message.success('Saved.'); setOpen(false); setEditing(null); form.resetFields(); qc.invalidateQueries({ queryKey: ['suppliers'] }); },
    onError: (e) => message.error(apiError(e)),
  });
  const del = useMutation({ mutationFn: (id: number) => api.delete(`/suppliers/${id}`), onSuccess: () => { message.success('Deleted.'); qc.invalidateQueries({ queryKey: ['suppliers'] }); }, onError: (e) => message.error(apiError(e)) });

  const openNew = () => { setEditing(null); form.resetFields(); form.setFieldsValue({ type: 'MATERIAL', isActive: true }); setOpen(true); };
  const openEdit = (s: Supplier) => { setEditing(s); form.setFieldsValue(s); setOpen(true); };

  const grouped = useMemo(() => GROUPS.map((g) => ({ ...g, rows: (suppliers ?? []).filter((s) => g.match.includes(s.type)) })), [suppliers]);

  const cols: ColumnsType<Supplier> = [
    { title: 'Code', dataIndex: 'code', width: 110, render: (c) => <b>{c}</b> },
    { title: 'Name', dataIndex: 'name' },
    { title: 'Type', dataIndex: 'type', width: 100, render: (t) => <Tag>{t}</Tag> },
    { title: 'Contact', dataIndex: 'contactName', render: (v) => v || '—' },
    { title: 'Phone', dataIndex: 'phone', render: (v) => v || '—' },
    { title: 'GST', dataIndex: 'gstNo', render: (v) => v || '—' },
    { title: 'Active', dataIndex: 'isActive', width: 70, render: (v) => (v ? <Tag color="green">Yes</Tag> : <Tag>No</Tag>) },
    ...(can('suppliers.manage') ? [{
      title: '', key: 'a', width: 90,
      render: (_: any, r: Supplier) => (
        <Space>
          <Tooltip title="Edit this supplier">
            <Button size="small" aria-label="Edit this supplier" icon={<EditOutlined />} onClick={() => openEdit(r)} />
          </Tooltip>
          {can('suppliers.manage') && <Popconfirm title="Delete supplier?" onConfirm={() => del.mutate(r.id)} okButtonProps={{ danger: true }}><Tooltip title="Delete this supplier"><Button size="small" danger aria-label="Delete this supplier" icon={<DeleteOutlined />} /></Tooltip></Popconfirm>}
        </Space>
      ),
    }] : []),
  ];

  return (
    <div>
      <Breadcrumb style={{ marginBottom: 16 }} items={[{ title: <Link to="/"><HomeOutlined /></Link> }, { title: <Link to="/operations">Operations</Link> }, { title: 'Suppliers' }]} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div><Title level={3} style={{ margin: 0 }}>Suppliers</Title><Text type="secondary">Grouped by type. Dues appear under Payments.</Text></div>
        {can('suppliers.manage') && <Button type="primary" icon={<PlusOutlined />} onClick={openNew}>Add Supplier</Button>}
      </div>

      <Collapse defaultActiveKey={['MATERIAL', 'JOBWORK']} items={grouped.map((g) => ({
        key: g.key,
        label: <span><b>{g.label}</b> <Tag style={{ marginLeft: 6 }}>{g.rows.length}</Tag></span>,
        children: <Table<Supplier> rowKey="id" size="small" loading={isLoading} columns={cols} dataSource={g.rows} pagination={false} scroll={{ x: 800 }} />,
      }))} />

      <Modal title={editing ? `Edit ${editing.name}` : 'Add supplier'} open={open} onCancel={() => { setOpen(false); setEditing(null); }} onOk={() => form.submit()} confirmLoading={save.isPending} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} style={{ marginTop: 12 }}>
          <Row gutter={12}>
            <Col span={8}><Form.Item name="code" label="Code" rules={[{ required: true }]}><Input disabled={!!editing} /></Form.Item></Col>
            <Col span={16}><Form.Item name="name" label="Name" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col span={10}><Form.Item name="type" label="Type" rules={[{ required: true }]}><Select options={[{ label: 'Material', value: 'MATERIAL' }, { label: 'Jobwork', value: 'JOBWORK' }, { label: 'Both', value: 'BOTH' }]} /></Form.Item></Col>
            <Col span={14}><Form.Item name="contactName" label="Contact"><Input /></Form.Item></Col>
            <Col span={12}><Form.Item name="phone" label="Phone"><Input /></Form.Item></Col>
            <Col span={12}><Form.Item name="gstNo" label="GST No."><Input /></Form.Item></Col>
            <Col span={24}><Form.Item name="address" label="Address"><Input.TextArea rows={2} /></Form.Item></Col>
            <Col span={16}><Form.Item name="paymentTerms" label="Payment terms"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="isActive" label="Active" valuePropName="checked"><Switch /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>
    </div>
  );
}
