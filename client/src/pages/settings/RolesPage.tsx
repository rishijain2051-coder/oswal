/**
 * Settings → Roles. Create roles and decide what each one may do.
 *
 * The screen is built around one belief: the person granting a permission is usually not the
 * person who wrote the route, so a checkbox labelled `board.workers` tells them nothing. Every
 * permission therefore shows its own paragraph, what it ALLOWS, and — the part that actually
 * prevents mistakes — what it still BLOCKS, which is the near-miss a granter would otherwise
 * assume came with it.
 *
 * Prerequisites are handled by ticking them FOR you and saying so, rather than by refusing the
 * save. Unticking a view permission warns what depends on it.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Alert,
  Badge,
  Breadcrumb,
  Button,
  Card,
  Checkbox,
  Collapse,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  HomeOutlined,
  LockOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Link } from 'react-router-dom';
import type { ColumnsType } from 'antd/es/table';
import { apiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { dependents, useDeleteRole, usePermissionCatalogue, useRoles, useSaveRole, withRequired } from '../../api/roles';
import type { PermissionDef, Role } from '../../api/types';

const { Title, Text, Paragraph } = Typography;

const RISK_TAG: Record<string, { color: string; label: string }> = {
  normal: { color: 'default', label: 'Normal' },
  sensitive: { color: 'gold', label: 'Discloses information' },
  destructive: { color: 'red', label: 'Loses data or money' },
};

/** One permission, with the prose that makes it grantable by a human. */
function PermissionRow({
  def,
  checked,
  disabled,
  onToggle,
}: {
  def: PermissionDef;
  checked: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  const risk = RISK_TAG[def.risk] ?? RISK_TAG.normal;
  return (
    <div
      style={{
        padding: '10px 12px',
        borderTop: '1px solid #f0f0f0',
        background: checked ? '#fcfaf8' : undefined,
      }}
    >
      <Checkbox checked={checked} disabled={disabled} onChange={(e) => onToggle(e.target.checked)}>
        <Space size={6} wrap>
          <Text strong>{def.label}</Text>
          {def.risk !== 'normal' && <Tag color={risk.color}>{risk.label}</Tag>}
          <Text code style={{ fontSize: 11 }}>
            {def.key}
          </Text>
        </Space>
      </Checkbox>

      <div style={{ marginLeft: 24, marginTop: 4 }}>
        <Paragraph type="secondary" style={{ marginBottom: 6, fontSize: 13 }}>
          {def.what}
        </Paragraph>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 12 }}>
          <div style={{ flex: '1 1 240px', minWidth: 220 }}>
            <Text strong style={{ fontSize: 12, color: '#237804' }}>
              Lets them
            </Text>
            <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
              {def.allows.map((a) => (
                <li key={a}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {a}
                  </Text>
                </li>
              ))}
            </ul>
          </div>
          <div style={{ flex: '1 1 240px', minWidth: 220 }}>
            <Text strong style={{ fontSize: 12, color: '#a8071a' }}>
              Still does not let them
            </Text>
            <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
              {def.blocks.map((b) => (
                <li key={b}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {b}
                  </Text>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function RolesPage() {
  const { can, isOwner, user, refreshUser } = useAuth();
  const { message } = App.useApp();
  const [form] = Form.useForm();

  const editable = can('roles.manage');
  const { data: roles, isLoading } = useRoles(can('roles.view'));
  const { data: catalogue } = usePermissionCatalogue(can('roles.view'));
  const save = useSaveRole();
  const del = useDeleteRole();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Role | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [autoAdded, setAutoAdded] = useState<string[]>([]);

  const defs = useMemo(() => catalogue?.permissions ?? [], [catalogue]);

  // Reset the picker whenever a different role is opened.
  useEffect(() => {
    if (!open) return;
    setPicked(new Set(editing?.permissions ?? []));
    setAutoAdded([]);
    form.setFieldsValue({
      name: editing?.name ?? '',
      description: editing?.description ?? '',
      isActive: editing?.isActive ?? true,
    });
  }, [open, editing, form]);

  const toggle = (key: string, next: boolean) => {
    setPicked((prev) => {
      const now = new Set(prev);
      if (next) {
        const before = new Set(now);
        for (const k of withRequired([key], defs)) now.add(k);
        // Say what was added on your behalf rather than letting boxes tick themselves.
        const added = [...now].filter((k) => !before.has(k) && k !== key);
        if (added.length) setAutoAdded(added);
      } else {
        now.delete(key);
        // Anything that required this key is now unusable, so it goes too.
        for (const dep of dependents(key, now, defs)) now.delete(dep);
      }
      return now;
    });
  };

  const submit = async () => {
    const values = await form.validateFields();
    try {
      await save.mutateAsync({
        id: editing?.id,
        name: values.name.trim(),
        description: values.description?.trim() ?? '',
        isActive: values.isActive ?? true,
        permissions: [...picked],
      });
      message.success(editing ? 'Role updated.' : 'Role created.');
      // If that was your own role, what you may do has just changed on the server — the menu
      // and every gated button have to be told, or they keep offering what is now refused.
      if (editing && user?.role?.id === editing.id) await refreshUser();
      setOpen(false);
      setEditing(null);
    } catch (e) {
      message.error(apiError(e));
    }
  };

  const columns: ColumnsType<Role> = [
    {
      title: 'Role',
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Space size={6}>
            <Text strong>{r.name}</Text>
            {!r.isActive && <Tag>Deactivated</Tag>}
            {user?.role?.id === r.id && <Tag color="blue">Yours</Tag>}
          </Space>
          {r.description && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {r.description}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: 'Permissions',
      width: 130,
      render: (_, r) => {
        const risky = r.permissions.filter((k) => defs.find((d) => d.key === k)?.risk === 'destructive').length;
        return (
          <Space size={4}>
            <Badge count={r.permissions.length} showZero style={{ backgroundColor: '#8d6e63' }} />
            {risky > 0 && (
              <Tooltip title={`${risky} permission(s) that can lose data or money`}>
                <Tag color="red" style={{ marginInlineEnd: 0 }}>
                  <WarningOutlined /> {risky}
                </Tag>
              </Tooltip>
            )}
          </Space>
        );
      },
    },
    { title: 'Users', dataIndex: 'users', width: 80 },
    {
      title: '',
      width: 100,
      render: (_, r) => (
        <Space>
          <Tooltip title={editable ? 'Edit this role' : 'View this role'}>
            <Button
              size="small"
              aria-label="Edit this role"
              icon={<EditOutlined />}
              onClick={() => {
                setEditing(r);
                setOpen(true);
              }}
            />
          </Tooltip>
          {editable && (
            <Popconfirm
              title="Delete this role?"
              description={r.users > 0 ? `${r.users} user(s) hold it — they must be moved first.` : 'Nobody holds it.'}
              okButtonProps={{ danger: true }}
              onConfirm={async () => {
                try {
                  await del.mutateAsync(r.id);
                  message.success('Role deleted.');
                } catch (e) {
                  message.error(apiError(e));
                }
              }}
            >
              <Tooltip title="Delete this role">
                <Button size="small" danger aria-label="Delete this role" icon={<DeleteOutlined />} />
              </Tooltip>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  /** Removing this from your own role would lock you out, so the box is held down. */
  const lockedForMe = (key: string) => !isOwner && editing != null && user?.role?.id === editing.id && key === 'roles.manage';

  return (
    <div>
      <Breadcrumb style={{ marginBottom: 16 }} items={[{ title: <Link to="/"><HomeOutlined /></Link> }, { title: 'Settings' }, { title: 'Roles' }]} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>
            Roles &amp; Permissions
          </Title>
          <Text type="secondary">
            The app ships no roles — every one of them is yours. {defs.length} permissions are available.
          </Text>
        </div>
        {editable && (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            New Role
          </Button>
        )}
      </div>

      {roles?.length === 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="No roles yet"
          description="Until a role exists and is assigned, everybody except an owner can sign in and see nothing. Create the roles your factory actually has — a shop-floor login that records production, a coordinator who handles orders, an accountant who sees money — and assign them on the Users screen."
        />
      )}

      <Card>
        <Table rowKey="id" size="small" loading={isLoading} dataSource={roles ?? []} columns={columns} pagination={false} />
      </Card>

      <Modal
        open={open}
        width={920}
        title={editing ? `Edit role — ${editing.name}` : 'New role'}
        okText={editing ? 'Save role' : 'Create role'}
        okButtonProps={{ disabled: !editable, loading: save.isPending }}
        onOk={submit}
        onCancel={() => {
          setOpen(false);
          setEditing(null);
        }}
        styles={{ body: { maxHeight: '68vh', overflowY: 'auto' } }}
      >
        <Form form={form} layout="vertical" disabled={!editable}>
          <Space align="start" style={{ width: '100%' }} size={16}>
            <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Give the role a name.' }]} style={{ flex: 1, minWidth: 220 }}>
              <Input placeholder="e.g. Production Supervisor" />
            </Form.Item>
            <Form.Item name="isActive" label="Active" valuePropName="checked" tooltip="A deactivated role grants nothing to the people who hold it.">
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item name="description" label="What this role is for">
            <Input.TextArea rows={2} placeholder="Records production on the floor. No money, no rates." />
          </Form.Item>
        </Form>

        <Space style={{ marginBottom: 8 }} wrap>
          <Text strong>{picked.size}</Text>
          <Text type="secondary">of {defs.length} permissions granted</Text>
        </Space>

        {autoAdded.length > 0 && (
          <Alert
            type="info"
            showIcon
            closable
            onClose={() => setAutoAdded([])}
            style={{ marginBottom: 12 }}
            message="Some permissions were added automatically"
            description={
              <>
                {autoAdded.map((k) => defs.find((d) => d.key === k)?.label ?? k).join(', ')} — an edit permission is
                useless without the matching view permission, so it was ticked for you.
              </>
            }
          />
        )}

        {catalogue ? (
          <Collapse
            accordion={false}
            items={catalogue.modules.map((group) => {
              const granted = group.permissions.filter((p) => picked.has(p.key)).length;
              return {
                key: group.module,
                label: (
                  <Space>
                    <Text strong>{group.module}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {granted} of {group.permissions.length}
                    </Text>
                  </Space>
                ),
                extra: granted > 0 ? <Badge count={granted} style={{ backgroundColor: '#8d6e63' }} /> : null,
                children: (
                  <div style={{ margin: '-12px -16px -12px' }}>
                    {group.permissions.map((def) => (
                      <PermissionRow
                        key={def.key}
                        def={def}
                        checked={picked.has(def.key)}
                        disabled={!editable || lockedForMe(def.key)}
                        onToggle={(next) => toggle(def.key, next)}
                      />
                    ))}
                  </div>
                ),
              };
            })}
          />
        ) : (
          <Empty description="Loading the permission catalogue…" />
        )}

        {editing && user?.role?.id === editing.id && !isOwner && (
          <Alert
            type="warning"
            showIcon
            icon={<LockOutlined />}
            style={{ marginTop: 12 }}
            message="This is your own role"
            description='"Create and change roles" is held down, because removing it would leave you unable to put it back. An owner can always repair a role.'
          />
        )}
      </Modal>

      <Alert
        type="info"
        showIcon
        icon={<SafetyCertificateOutlined />}
        style={{ marginTop: 16 }}
        message="Owners sit outside all of this"
        description="An owner holds every permission regardless of their role, and the last active owner cannot be removed or demoted. That is deliberate: permissions are read from the database on every request, so without it a role that lost “Create and change roles” could lock the whole app shut with no way back. Owner status is granted on the Users screen, by an owner."
      />
    </div>
  );
}
