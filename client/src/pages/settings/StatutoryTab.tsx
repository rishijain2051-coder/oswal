import { useState } from 'react';
import { Alert, App, Button, Card, Col, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, apiError } from '../../api/client';
import { MANFORCE_KEYS, useStatutoryComponents, type StatutoryComponent } from '../../api/manforce';
import { useAuth } from '../../auth/AuthContext';
import { num } from '../../util/format';

const { Text, Paragraph } = Typography;

/**
 * The statutory levies, as DATA.
 *
 * Rates and ceilings change with the law, so nothing here is hard-coded — the same
 * approach as the cost formulas. PF, ESI, professional tax and statutory bonus ship as
 * editable defaults; a new levy is a new row, not a release.
 */
export default function StatutoryTab() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { can } = useAuth();
  const canEdit = can('statutory.components.manage');
  const { data: components, isLoading } = useStatutoryComponents();
  const [editing, setEditing] = useState<StatutoryComponent | 'new' | null>(null);
  const [form] = Form.useForm();

  const refresh = () => {
    for (const k of MANFORCE_KEYS) qc.invalidateQueries({ queryKey: k });
  };

  const open = (c: StatutoryComponent | 'new') => {
    setEditing(c);
    form.setFieldsValue(
      c === 'new'
        ? { code: '', name: '', employeePct: 0, employerPct: 0, flatAmount: 0, basis: 'GROSS', wageCeiling: null, eligibilityCeiling: null, minWages: null, payeeName: '', isProvision: false, isActive: true, sortOrder: (components?.length ?? 0) + 1, notes: '' }
        : { ...c }
    );
  };

  const save = useMutation({
    mutationFn: (v: any) => {
      const body = {
        ...v,
        wageCeiling: v.wageCeiling ?? null,
        eligibilityCeiling: v.eligibilityCeiling ?? null,
        minWages: v.minWages ?? null,
      };
      return editing === 'new' ? api.post('/statutory-components', body) : api.patch(`/statutory-components/${(editing as StatutoryComponent).id}`, body);
    },
    onSuccess: () => {
      message.success('Saved. Future postings use the new figures; anything already posted stays as it was.');
      setEditing(null);
      refresh();
    },
    onError: (e) => message.error(apiError(e)),
  });

  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/statutory-components/${id}`),
    onSuccess: () => {
      message.success('Removed.');
      refresh();
    },
    onError: (e) => message.error(apiError(e)),
  });

  return (
    <div>
      <Paragraph type="secondary">
        A component applies to a worker only if it is ticked on their record. Amounts are computed from the wages earned in the period you post, and become a real liability only when
        posted from <b>Manforce → Statutory</b>.
      </Paragraph>
      {!canEdit && <Alert type="info" showIcon style={{ marginBottom: 16 }} message="Only an Admin can change the levies." />}
      {canEdit && (
        <Button type="primary" icon={<PlusOutlined />} onClick={() => open('new')} style={{ marginBottom: 12 }}>
          Add a levy
        </Button>
      )}

      <Table<StatutoryComponent>
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={components ?? []}
        pagination={false}
        columns={[
          { title: 'Code', dataIndex: 'code', width: 100 },
          { title: 'Name', dataIndex: 'name' },
          {
            title: 'Employee',
            dataIndex: 'employeePct',
            width: 120,
            align: 'right',
            render: (v, c) => (c.flatAmount > 0 ? `₹${num(c.flatAmount, 0)} flat` : v ? `${num(v, 2)}%` : '—'),
          },
          { title: 'Employer', dataIndex: 'employerPct', width: 110, align: 'right', render: (v) => (v ? `${num(v, 2)}%` : '—') },
          {
            title: 'Computed on',
            dataIndex: 'basis',
            width: 160,
            render: (v) => (
              <Tooltip title={v === 'BASIC' ? 'Overtime is excluded, which is how PF is normally worked out.' : 'Everything the worker earned in the period.'}>
                <Tag>{v === 'BASIC' ? 'wages, no OT' : 'all wages'}</Tag>
              </Tooltip>
            ),
          },
          {
            title: 'Ceilings',
            key: 'ceilings',
            render: (_, c) =>
              [
                c.wageCeiling ? `contribution capped at ₹${num(c.wageCeiling, 0)}` : null,
                c.eligibilityCeiling ? `not covered above ₹${num(c.eligibilityCeiling, 0)}` : null,
                c.minWages ? `only from ₹${num(c.minWages, 0)}` : null,
              ]
                .filter(Boolean)
                .join(' · ') || '—',
          },
          { title: 'Payee', dataIndex: 'payeeName', width: 140, render: (v) => v || '—' },
          { title: 'Covers', dataIndex: 'covered', width: 90, align: 'right', render: (v) => `${v}` },
          {
            title: '',
            key: 'state',
            width: 120,
            render: (_, c) => (
              <Space size={4}>
                {c.isProvision && (
                  <Tooltip title="Accrued as a cost but not owed to anyone until declared, so it never counts as payable.">
                    <Tag>provision</Tag>
                  </Tooltip>
                )}
                {!c.isActive && <Tag color="default">off</Tag>}
              </Space>
            ),
          },
          ...(canEdit
            ? [
                {
                  title: '',
                  key: 'x',
                  width: 90,
                  render: (_: unknown, c: StatutoryComponent) => (
                    <Space size={4}>
                      <Button size="small" type="text" icon={<EditOutlined />} onClick={() => open(c)} />
                      <Popconfirm
                        title={`Delete ${c.code}?`}
                        description={c.postedLines > 0 ? `It has ${c.postedLines} posted line(s) — the server will refuse. Deactivate it instead.` : 'This cannot be undone.'}
                        onConfirm={() => del.mutate(c.id)}
                      >
                        <Button size="small" danger type="text" icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]
            : []),
        ]}
      />

      <Modal
        open={editing != null}
        title={editing === 'new' ? 'Add a levy' : `Edit ${(editing as StatutoryComponent)?.code ?? ''}`}
        onCancel={() => setEditing(null)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
        okText="Save"
        width={640}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <Row gutter={12}>
            <Col span={6}>
              <Form.Item name="code" label="Code" rules={[{ required: true }]}>
                <Input placeholder="PF" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="name" label="Name" rules={[{ required: true }]}>
                <Input placeholder="Provident Fund" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="sortOrder" label="Order">
                <InputNumber style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="employeePct" label="Employee share (%)" extra="Deducted from the worker.">
                <InputNumber min={0} max={100} step={0.25} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="employerPct" label="Employer share (%)" extra="The factory's own cost.">
                <InputNumber min={0} max={100} step={0.25} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="flatAmount" label="Flat amount (₹)" extra="Set for a fixed deduction like professional tax. Replaces the employee percentage.">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item name="basis" label="Computed on">
            <Select
              options={[
                { value: 'GROSS', label: 'All wages earned in the period' },
                { value: 'BASIC', label: 'Wages excluding overtime' },
              ]}
            />
          </Form.Item>

          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="wageCeiling" label="Contribution ceiling (₹)" extra="The percentage applies to at most this much. PF is ₹15,000 today.">
                <InputNumber min={0} style={{ width: '100%' }} placeholder="none" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="eligibilityCeiling" label="Eligibility ceiling (₹)" extra="Earn more than this and the worker is out of the scheme entirely. ESI is ₹21,000.">
                <InputNumber min={0} style={{ width: '100%' }} placeholder="none" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="minWages" label="Applies from (₹)" extra="Below this, nothing is due.">
                <InputNumber min={0} style={{ width: '100%' }} placeholder="none" />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="payeeName" label="Paid to">
                <Input placeholder="EPFO, ESIC, State Government…" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="isProvision" label="Provision only" valuePropName="checked" tooltip="A cost that is accrued but owed to nobody until declared — a bonus, for instance.">
                <Switch />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="isActive" label="Active" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Text type="secondary">Changing a rate never restates a posting that has already been made — the amounts are stored on the posting for exactly that reason.</Text>
        </Form>
      </Modal>
    </div>
  );
}
