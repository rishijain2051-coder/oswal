import { useState } from 'react';
import { Alert, Breadcrumb, Button, Card, Form, Input, Modal, Result, Select, Space, Switch, Table, Tag, Tooltip, Typography, App } from 'antd';
import { HomeOutlined, PlusOutlined, EditOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnsType } from 'antd/es/table';
import { api, apiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { useRoles } from '../../api/roles';
import type { User } from '../../api/types';

const { Title, Text } = Typography;

export default function UsersPage() {
  const { can, isOwner, user: me, refreshUser } = useAuth();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);

  const { data: users, isLoading } = useQuery({
    enabled: can('users.view'),
    queryKey: ['users'],
    queryFn: async () => (await api.get<User[]>('/users')).data,
  });

  const { data: roles } = useRoles(can('users.view'));

  const save = useMutation({
    mutationFn: async (values: Record<string, unknown>) => {
      if (editing) return api.patch(`/users/${editing.id}`, values);
      return api.post('/users', values);
    },
    onSuccess: (_data, variables) => {
      message.success('Saved.');
      qc.invalidateQueries({ queryKey: ['users'] });
      // Moving YOURSELF to another role changes what you may do on the very next request.
      // `editing` is read before it is cleared below, and the identity is held in
      // AuthContext state rather than a query cache — so it needs asking for again.
      if (editing?.id === me?.id && (variables as { roleId?: number | null }).roleId !== undefined) void refreshUser();
      setOpen(false);
      setEditing(null);
      form.resetFields();
    },
    onError: (e) => message.error(apiError(e)),
  });

  /**
   * Owner status is a separate endpoint because it is a separate authority: holding
   * `users.manage` must not be enough to make yourself an owner, or the guard protecting the
   * last owner would be decoration.
   */
  const setOwner = useMutation({
    mutationFn: async ({ id, isOwner: next }: { id: number; isOwner: boolean }) => api.patch(`/users/${id}/owner`, { isOwner: next }),
    onSuccess: (_data, variables) => {
      message.success('Owner status updated.');
      qc.invalidateQueries({ queryKey: ['users'] });
      // Giving up your own owner status takes every permission with it, immediately.
      if (variables.id === me?.id) void refreshUser();
    },
    onError: (e) => message.error(apiError(e)),
  });

  if (!can('users.view')) {
    return <Result status="403" title="You do not have access to this" subTitle='Managing logins needs the "See users" permission.' />;
  }

  const editable = can('users.manage');

  const openNew = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ roleId: null, isActive: true });
    setOpen(true);
  };
  const openEdit = (u: User) => {
    setEditing(u);
    form.setFieldsValue({ name: u.name, roleId: u.role?.id ?? null, isActive: u.isActive });
    setOpen(true);
  };

  // A deactivated role is offered only if somebody is already on it, so an existing
  // assignment can be seen — but a new one cannot be made, which the server also refuses.
  const roleOpts = (roles ?? [])
    .filter((r) => r.isActive || users?.some((u) => u.role?.id === r.id))
    .map((r) => ({
      label: r.isActive ? `${r.name} · ${r.permissions.length} permissions` : `${r.name} (deactivated)`,
      value: r.id,
      disabled: !r.isActive,
    }));

  const columns: ColumnsType<User> = [
    { title: 'Name', dataIndex: 'name' },
    { title: 'Email', dataIndex: 'email' },
    {
      title: 'Role',
      render: (_, u) =>
        u.role ? (
          <Space size={4}>
            <Tag color="#8d6e63">{u.role.name}</Tag>
            {u.role.isActive === false && <Tag>Role deactivated</Tag>}
          </Space>
        ) : (
          <Tooltip title="No role, so no permissions at all. They can sign in and see nothing.">
            <Tag>No role</Tag>
          </Tooltip>
        ),
    },
    {
      title: 'Owner',
      width: 110,
      render: (_, u) =>
        isOwner ? (
          <Tooltip title={u.isOwner ? 'Holds every permission. Click to remove.' : 'Grant every permission, outside the role system.'}>
            <Switch
              size="small"
              checked={u.isOwner}
              loading={setOwner.isPending}
              onChange={(next) => setOwner.mutate({ id: u.id, isOwner: next })}
            />
          </Tooltip>
        ) : u.isOwner ? (
          <Tag color="#6d4c41">Owner</Tag>
        ) : null,
    },
    { title: 'Active', dataIndex: 'isActive', render: (v) => (v ? <Tag color="green">Yes</Tag> : <Tag color="red">No</Tag>) },
    {
      title: 'Actions',
      key: 'a',
      width: 90,
      render: (_, u) => (
        <Tooltip title={editable ? 'Edit this user' : 'You cannot edit users'}>
          <Button size="small" disabled={!editable} aria-label="Edit this user" icon={<EditOutlined />} onClick={() => openEdit(u)} />
        </Tooltip>
      ),
    },
  ];

  return (
    <div>
      <Breadcrumb style={{ marginBottom: 16 }} items={[{ title: <Link to="/"><HomeOutlined /></Link> }, { title: 'Users' }]} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>
            Users
          </Title>
          <Text type="secondary">
            A login can do exactly what its role allows — nothing more, and nothing by default.{' '}
            {can('roles.view') && <Link to="/settings/roles">Manage roles</Link>}
          </Text>
        </div>
        {editable && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openNew}>
            Add user
          </Button>
        )}
      </div>

      {roles?.length === 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="There are no roles yet"
          description={
            <>
              Every account except an owner will be able to sign in and see nothing until you create a role and assign
              it. {can('roles.manage') ? <Link to="/settings/roles">Create the first role</Link> : 'Ask an owner to create one.'}
            </>
          }
        />
      )}

      <Card>
        <Table<User> rowKey="id" size="small" loading={isLoading} columns={columns} dataSource={users ?? []} pagination={false} />
      </Card>

      <Alert
        type="info"
        showIcon
        icon={<SafetyCertificateOutlined />}
        style={{ marginTop: 16 }}
        message="About owners"
        description="An owner holds every permission regardless of their role, and the last active owner cannot be deactivated, deleted or demoted — otherwise a misconfigured role could lock the app shut with no way back in. Only an owner can grant or remove owner status."
      />

      <Modal
        title={editing ? `Edit ${editing.name}` : 'Add user'}
        open={open}
        onCancel={() => {
          setOpen(false);
          setEditing(null);
        }}
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
          <Form.Item
            name="password"
            label={editing ? 'New password (leave blank to keep)' : 'Password'}
            rules={editing ? [{ min: 8, message: 'Use at least 8 characters.' }] : [{ required: true, min: 8, message: 'Use at least 8 characters.' }]}
          >
            <Input.Password placeholder="min 8 characters" />
          </Form.Item>
          <Form.Item
            name="roleId"
            label="Role"
            tooltip="Leave empty and the account can sign in but do nothing. That is the safe default for an account being set up."
          >
            <Select allowClear placeholder="No role — no permissions" options={roleOpts} />
          </Form.Item>
          {editing && editing.id === me?.id && (
            <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="This is your own account" description="Changing your role changes what you can do, immediately." />
          )}
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
