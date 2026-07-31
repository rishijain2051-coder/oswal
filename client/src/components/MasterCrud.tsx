import { useState } from 'react';
import { Button, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Tooltip, App } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnsType } from 'antd/es/table';
import { api, apiError } from '../api/client';

export interface FieldDef {
  name: string;
  label: string;
  type: 'text' | 'number' | 'switch' | 'select';
  required?: boolean;
  step?: number;
  defaultValue?: unknown;
  width?: number;
  options?: { label: string; value: string | number }[];
  hideInTable?: boolean;
}

interface Row {
  id: number;
  [k: string]: unknown;
}

export default function MasterCrud({
  endpoint,
  queryKey,
  fields,
  fixed,
  listParams,
}: {
  endpoint: string;
  queryKey: unknown[];
  fields: FieldDef[];
  fixed?: Record<string, unknown>;
  listParams?: Record<string, unknown>;
}) {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: async () => (await api.get<Row[]>(endpoint, { params: listParams })).data,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey });

  const upsert = useMutation({
    mutationFn: async (values: Record<string, unknown>) => {
      if (editingId) return api.patch(`${endpoint}/${editingId}`, values);
      return api.post(endpoint, { ...fixed, ...values });
    },
    onSuccess: () => {
      message.success('Saved.');
      setOpen(false);
      setEditingId(null);
      form.resetFields();
      invalidate();
    },
    onError: (e) => message.error(apiError(e)),
  });

  const del = useMutation({
    mutationFn: (id: number) => api.delete(`${endpoint}/${id}`),
    onSuccess: () => { message.success('Deleted.'); invalidate(); },
    onError: (e) => message.error(apiError(e)),
  });

  const openNew = () => {
    setEditingId(null);
    form.resetFields();
    const defaults: Record<string, unknown> = {};
    for (const f of fields) if (f.defaultValue !== undefined) defaults[f.name] = f.defaultValue;
    form.setFieldsValue(defaults);
    setOpen(true);
  };

  const openEdit = (row: Row) => {
    setEditingId(row.id);
    form.setFieldsValue(row);
    setOpen(true);
  };

  const columns: ColumnsType<Row> = [
    ...fields
      .filter((f) => !f.hideInTable)
      .map((f) => ({
        title: f.label,
        dataIndex: f.name,
        width: f.width,
        render: (v: unknown) => {
          if (f.type === 'switch') return v ? <Tag color="green">Yes</Tag> : <Tag>No</Tag>;
          if (f.type === 'select') return v == null || v === '' ? '—' : <Tag>{String(v)}</Tag>;
          return v == null || v === '' ? '—' : String(v);
        },
      })),
    {
      title: 'Actions',
      key: 'actions',
      width: 110,
      render: (_, row) => (
        <Space>
          <Tooltip title="Edit this entry">
            <Button size="small" aria-label="Edit this entry" icon={<EditOutlined />} onClick={() => openEdit(row)} />
          </Tooltip>
          <Popconfirm title="Delete this entry?" onConfirm={() => del.mutate(row.id)} okButtonProps={{ danger: true }}>
            <Tooltip title="Delete this entry">
              <Button size="small" danger aria-label="Delete this entry" icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Button type="primary" icon={<PlusOutlined />} onClick={openNew} style={{ marginBottom: 12 }}>
        Add
      </Button>
      <Table<Row> rowKey="id" size="small" loading={isLoading} columns={columns} dataSource={data ?? []} pagination={{ pageSize: 15 }} />

      <Modal
        title={editingId ? 'Edit' : 'Add'}
        open={open}
        onCancel={() => { setOpen(false); setEditingId(null); }}
        onOk={() => form.submit()}
        confirmLoading={upsert.isPending}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={(v) => upsert.mutate(v)} style={{ marginTop: 12 }}>
          {fields.map((f) => (
            <Form.Item
              key={f.name}
              name={f.name}
              label={f.label}
              valuePropName={f.type === 'switch' ? 'checked' : 'value'}
              rules={f.required ? [{ required: true, message: `${f.label} is required` }] : undefined}
            >
              {f.type === 'switch' ? (
                <Switch />
              ) : f.type === 'number' ? (
                <InputNumber style={{ width: '100%' }} step={f.step ?? 1} />
              ) : f.type === 'select' ? (
                <Select options={f.options} />
              ) : (
                <Input />
              )}
            </Form.Item>
          ))}
        </Form>
      </Modal>
    </div>
  );
}
