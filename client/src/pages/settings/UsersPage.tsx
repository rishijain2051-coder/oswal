import { useState } from 'react';
import { Breadcrumb, Button, Card, Form, Input, Modal, Result, Select, Space, Table, Tag, Typography, App, Switch } from 'antd';
import { HomeOutlined, PlusOutlined, EditOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnsType } from 'antd/es/table';
import { api, apiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { useMeta } from '../../api/hooks';
import type { User } from '../../api/types';

const { Title, Text } = Typography;

const ROLE_COLOR: Record<string, string> = { Admin: '#6d4c41', Manager: '#8d6e63', Operator: '#a1887f', Viewer: 'default' };

export default function UsersPage() {
  const { hasRole } = useAuth();
  const { data: meta } = useMeta();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);

  const { data: users, isLoading } = useQuery({
    enabled: hasRole('Admin'),
    queryKey: ['users'],
    queryFn: async () => (await api.get<User[]>('/users')).data,
  });

  const save = useMutation({
    mutationFn: async (values: Record<string, unknown>) => {
      if (editing) return api.patch(`/users/${editing.id}`, values);
      return api.post('/users', values);
    },
    onSuccess: () => {
      message.success('Saved.');
      setOpen(false);
      setEditing(null);
      form.resetFields();
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) => message.error(apiError(e)),
  });

  if (!hasRole('Admin')) {
    return <Result status="403" title="Admins only" subTitle="User management is restricted to Admins." />;
  }

  const openNew = () => { setEditing(null); form.resetFields(); form.setFieldsValue({ role: 'Operator', isActive: true }); setOpen(true); };
  const openEdit = (u: User) => { setEditing(u); form.setFieldsValue({ name: u.name, role: u.role, isActive: u.isActive }); setOpen(true); };

  const roleOpts = (meta?.roles ?? ['Viewer', 'Operator', 'Manager', 'Admin']).map((r) => ({ label: r, value: r }));

  const columns: ColumnsType<User> = [
    { title: 'Name', dataIndex: 'name' },
    { title: 'Email', dataIndex: 'email' },
    { title: 'Role', dataIndex: 'role', render: (r) => <Tag color={ROLE_COLOR[r] ?? 'default'}>{r}</Tag> },
    { title: 'Active', dataIndex: 'isActive', render: (v) => (v ? <Tag color="green">Yes</Tag> : <Tag color="red">No</Tag>) },
    { title: 'Actions', key: 'a', width: 90, render: (_, u) => <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(u)} /> },
  ];

  return (
    <div>
      <Breadcrumb style={{ marginBottom: 16 }} items={[{ title: <Link to="/"><HomeOutlined /></Link> }, { title: 'Users' }]} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>Users & Roles</Title>
          <Text type="secondary">Admin &gt; Manager &gt; Operator &gt; Viewer. Higher roles can do everything lower ones can.</Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openNew}>Add user</Button>
      </div>

      <Card>
        <Table<User> rowKey="id" size="small" loading={isLoading} columns={columns} dataSource={users ?? []} pagination={false} />
      </Card>

      <Modal
        title={editing ? `Edit ${editing.name}` : 'Add user'}
        open={open}
        onCancel={() => { setOpen(false); setEditing(null); }}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} style={{ marginTop: 12 }}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          {!editing && (
            <Form.Item name="email" label="Email" rules={[{ required: true, type: 'email' }]}>
              <Input placeholder="person@oswal.local" />
            </Form.Item>
          )}
          <Form.Item name="password" label={editing ? 'New password (leave blank to keep)' : 'Password'} rules={editing ? [{ min: 6 }] : [{ required: true, min: 6 }]}>
            <Input.Password placeholder="min 6 characters" />
          </Form.Item>
          <Form.Item name="role" label="Role" rules={[{ required: true }]}>
            <Select options={roleOpts} />
          </Form.Item>
          {editing && (
            <Form.Item name="isActive" label="Active" valuePropName="checked">
              <Switch />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  );
}
