import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Checkbox, Col, DatePicker, Form, Input, InputNumber, Popconfirm, Row, Select, Space, Switch, Table, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import { api, apiError } from '../../api/client';
import { MANFORCE_KEYS, MONTHLY_DIVISORS, MONTHLY_DIVISOR_LABEL, WEEKDAYS, useWorkforceSettings } from '../../api/manforce';
import { useAuth } from '../../auth/AuthContext';

const { Text, Paragraph } = Typography;

/**
 * Which days the factory works, and how attendance turns into money.
 *
 * Everything here is read on every calculation rather than baked into stored wages, so
 * adding a festival — even a past one — corrects the accrual for that day immediately.
 */
export default function WorkforceTab() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { can } = useAuth();
  const canEdit = can('workforce.settings');
  const { data: settings } = useWorkforceSettings();
  const [form] = Form.useForm();
  const [holiday, setHoliday] = useState<{ date: Dayjs | null; name: string }>({ date: null, name: '' });

  useEffect(() => {
    if (!settings) return;
    form.setFieldsValue({
      weeklyOffDays: settings.weeklyOffDayList,
      presumePresent: settings.presumePresent,
      shiftHours: settings.shiftHours,
      otMultiplier: settings.otMultiplier,
      halfDayFactor: settings.halfDayFactor,
      monthlyDivisor: settings.monthlyDivisor,
      defaultAdvanceRecovery: settings.defaultAdvanceRecovery,
    });
  }, [settings, form]);

  const refresh = () => {
    for (const k of [...MANFORCE_KEYS, ['workforce-settings']]) qc.invalidateQueries({ queryKey: k });
  };

  const save = useMutation({
    mutationFn: (v: any) => api.put('/workforce/settings', v),
    onSuccess: () => {
      message.success('Saved. Every accrual is recalculated from these rules.');
      refresh();
    },
    onError: (e) => message.error(apiError(e)),
  });

  const addHoliday = useMutation({
    mutationFn: () => api.post('/holidays', { date: holiday.date!.startOf('day').toISOString(), name: holiday.name.trim() }),
    onSuccess: () => {
      message.success('Holiday added.');
      setHoliday({ date: null, name: '' });
      refresh();
    },
    onError: (e) => message.error(apiError(e)),
  });

  const delHoliday = useMutation({
    mutationFn: (id: number) => api.delete(`/holidays/${id}`),
    onSuccess: () => {
      message.success('Holiday removed — that day is a working day again.');
      refresh();
    },
    onError: (e) => message.error(apiError(e)),
  });

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={13}>
        <Card size="small" title="Working days and pay rules">
          {!canEdit && <Alert type="info" showIcon style={{ marginBottom: 16 }} message="Only an Admin can change these." />}
          <Form form={form} layout="vertical" disabled={!canEdit} onFinish={(v) => save.mutate(v)}>
            <Form.Item name="weeklyOffDays" label="Weekly off" extra="Nothing accrues on these days unless someone is explicitly marked present.">
              <Checkbox.Group options={WEEKDAYS.map((label, value) => ({ label, value }))} />
            </Form.Item>

            <Form.Item
              name="presumePresent"
              label="Presume everyone present"
              valuePropName="checked"
              extra="On: an active worker earns for every working day unless marked absent — you only record exceptions. Off: only days explicitly marked present earn."
            >
              <Switch />
            </Form.Item>

            <Row gutter={12}>
              <Col span={8}>
                <Form.Item name="shiftHours" label="Shift hours" extra="Used to derive an hourly rate.">
                  <InputNumber min={1} max={24} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="otMultiplier" label="Overtime multiplier" extra="Applied when a worker has no OT rate of their own.">
                  <InputNumber min={0} step={0.25} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="halfDayFactor" label="A half day is worth" extra="As a fraction of a full day.">
                  <InputNumber min={0} max={1} step={0.05} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item
              name="monthlyDivisor"
              label="A monthly salary is divided by"
              extra="How much one day of a salary is worth. Working days is exact: a full month accrues the salary and each absence docks precisely one day."
            >
              <Select options={MONTHLY_DIVISORS.map((v) => ({ value: v, label: MONTHLY_DIVISOR_LABEL[v] }))} />
            </Form.Item>

            <Form.Item
              name="defaultAdvanceRecovery"
              label="Default advance recovery (₹ per month)"
              extra="Suggested when handing over an advance. Zero means it is absorbed as fast as the worker earns."
            >
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>

            {canEdit && (
              <Button type="primary" loading={save.isPending} onClick={() => form.submit()}>
                Save rules
              </Button>
            )}
          </Form>
        </Card>
      </Col>

      <Col xs={24} lg={11}>
        <Card size="small" title={`Holiday calendar (${settings?.holidays.length ?? 0})`}>
          <Paragraph type="secondary" style={{ fontSize: 12 }}>
            A holiday is not paid unless a worker is explicitly marked present on it. Because wages are worked out on every read, adding or removing a date corrects the money for it
            straight away — including for days already past.
          </Paragraph>
          {canEdit && (
            <Space style={{ marginBottom: 12 }} wrap>
              <DatePicker value={holiday.date} onChange={(d) => setHoliday((h) => ({ ...h, date: d }))} format="DD MMM YYYY" placeholder="Date" />
              <Input placeholder="Diwali, Holi…" value={holiday.name} onChange={(e) => setHoliday((h) => ({ ...h, name: e.target.value }))} style={{ width: 180 }} />
              <Button
                type="primary"
                icon={<PlusOutlined />}
                disabled={!holiday.date || !holiday.name.trim()}
                loading={addHoliday.isPending}
                onClick={() => addHoliday.mutate()}
              >
                Add
              </Button>
            </Space>
          )}
          <Table
            rowKey="id"
            size="small"
            pagination={{ pageSize: 12, hideOnSinglePage: true }}
            dataSource={settings?.holidays ?? []}
            locale={{ emptyText: 'No holidays set' }}
            columns={[
              { title: 'Date', dataIndex: 'date', width: 150, render: (d) => dayjs(d).format('ddd DD MMM YYYY') },
              { title: 'Occasion', dataIndex: 'name' },
              ...(canEdit
                ? [
                    {
                      title: '',
                      key: 'x',
                      width: 50,
                      render: (_: unknown, r: { id: number }) => (
                        <Popconfirm title="Remove this holiday?" description="That day becomes a working day and will accrue again." onConfirm={() => delHoliday.mutate(r.id)}>
                          <Button size="small" danger type="text" icon={<DeleteOutlined />} />
                        </Popconfirm>
                      ),
                    },
                  ]
                : []),
            ]}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            Weekly offs are set on the left; only one-off dates belong here.
          </Text>
        </Card>
      </Col>
    </Row>
  );
}
