import { useMemo, useState } from 'react';
import { Alert, App, Breadcrumb, Button, Card, Col, DatePicker, Empty, Input, Modal, Popconfirm, Row, Space, Statistic, Table, Tag, Tooltip, Typography } from 'antd';
import { HomeOutlined, DeleteOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import { api, apiError } from '../../api/client';
import { MANFORCE_KEYS, useStatutoryComponents, useStatutoryPostings, useStatutoryPreview } from '../../api/manforce';
import { usePayables } from '../../api/ops';
import { useAuth } from '../../auth/AuthContext';
import { money, num } from '../../util/format';

const { Title, Text } = Typography;

/**
 * Statutory liability.
 *
 * Nothing is owed until it is POSTED. This screen shows what a period WOULD create —
 * computed from the wages actually earned in it — and posting turns that into a real
 * payable plus a deduction on each worker's account. Two postings may not overlap for
 * the same levy, or the same wages would be charged twice.
 */
export default function StatutoryPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const { hasRole } = useAuth();
  const canManage = hasRole('Manager');

  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf('month'), dayjs().endOf('month')]);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);

  const from = range[0].format('YYYY-MM-DD');
  const to = range[1].format('YYYY-MM-DD');
  const { data: preview, isLoading } = useStatutoryPreview(from, to, canManage);
  const { data: components } = useStatutoryComponents();
  const { data: postings } = useStatutoryPostings();
  const { data: payables } = usePayables();

  const statutoryPayables = useMemo(() => (payables ?? []).filter((p) => p.partyType === 'STATUTORY'), [payables]);

  /** One row per worker, with a column per component — how a payslip reads. */
  const rows = useMemo(() => {
    if (!preview) return [];
    const byWorker = new Map<number, { workerId: number; code: string; name: string; contractorName: string | null; wages: number; cells: Record<number, { employee: number; employer: number; covered: boolean; reason?: string; alreadyPosted: boolean }> }>();
    for (const l of preview.lines) {
      const row = byWorker.get(l.workerId) ?? { workerId: l.workerId, code: l.code, name: l.name, contractorName: l.contractorName, wages: 0, cells: {} };
      row.wages = Math.max(row.wages, l.wages);
      row.cells[l.componentId] = { employee: l.employeeAmt, employer: l.employerAmt, covered: l.covered, reason: l.reason, alreadyPosted: l.alreadyPosted };
      byWorker.set(l.workerId, row);
    }
    // Anyone with nothing due for any component is noise on this screen.
    return [...byWorker.values()].filter((r) => Object.values(r.cells).some((c) => c.covered));
  }, [preview]);

  const includedRows = rows.filter((r) => !excluded.has(r.workerId));

  const totals = useMemo(() => {
    let employee = 0;
    let employer = 0;
    for (const r of includedRows) {
      for (const c of Object.values(r.cells)) {
        if (!c.covered || c.alreadyPosted) continue;
        employee += c.employee;
        employer += c.employer;
      }
    }
    return { employee, employer, total: employee + employer, workers: includedRows.length };
  }, [includedRows]);

  const post = useMutation({
    mutationFn: () =>
      api.post('/statutory/postings', {
        from: range[0].startOf('day').toISOString(),
        to: range[1].startOf('day').toISOString(),
        componentIds: (preview?.components ?? []).map((c) => c.id),
        workerIds: includedRows.map((r) => r.workerId),
        note: note || null,
      }),
    onSuccess: () => {
      message.success('Liability posted.');
      setConfirming(false);
      setNote('');
      for (const k of MANFORCE_KEYS) qc.invalidateQueries({ queryKey: k });
    },
    onError: (e) => message.error(apiError(e)),
  });

  const reverse = useMutation({
    mutationFn: (id: number) => api.delete(`/statutory/postings/${id}`),
    onSuccess: () => {
      message.success('Posting reversed.');
      for (const k of MANFORCE_KEYS) qc.invalidateQueries({ queryKey: k });
    },
    onError: (e) => message.error(apiError(e)),
  });

  if (!canManage) {
    return (
      <Card>
        <Empty description="Statutory dues are a Manager's job." />
      </Card>
    );
  }

  return (
    <div>
      <Breadcrumb style={{ marginBottom: 16 }} items={[{ title: <Link to="/"><HomeOutlined /></Link> }, { title: <Link to="/manforce">Manforce</Link> }, { title: 'Statutory' }]} />
      <Title level={2} style={{ marginBottom: 2 }}>
        Statutory dues
      </Title>
      <Text type="secondary">Computed from the wages earned in a period. Nothing is owed to anyone until you post it.</Text>

      <Row gutter={[16, 16]} style={{ margin: '16px 0' }}>
        {statutoryPayables.map((s) => (
          <Col xs={12} md={6} key={s.partyId}>
            <Card size="small" hoverable onClick={() => navigate(`/finance/payments/statutory/${s.partyId}`)}>
              <Statistic
                title={`${s.code} ${s.isProvision ? 'provision' : 'owed'} (₹)`}
                value={num(s.isProvision ? s.accrued - s.paid : s.balance, 0)}
                valueStyle={{ color: s.isProvision ? '#8c8c8c' : '#cf1322' }}
              />
              <Text type="secondary" style={{ fontSize: 12 }}>
                posted {num(s.accrued, 0)} · paid {num(s.paid, 0)}
              </Text>
            </Card>
          </Col>
        ))}
        {statutoryPayables.length === 0 && (
          <Col span={24}>
            <Alert type="info" showIcon message="Nothing posted yet" description="Pick a period below, check what it would create, and post it when you are happy." />
          </Col>
        )}
      </Row>

      <Card
        size="small"
        title="What this period would create"
        extra={
          <Space wrap>
            {/* A range picker renders TWO inputs, so it takes an id per end. */}
            <DatePicker.RangePicker
              id={{ start: 'statutory-from', end: 'statutory-to' }}
              name="statutory-period"
              value={range}
              onChange={(v) => v && setRange(v as [Dayjs, Dayjs])}
              format="DD MMM YYYY"
              allowClear={false}
            />
            <Button size="small" onClick={() => setRange([dayjs().startOf('month'), dayjs().endOf('month')])}>
              this month
            </Button>
            <Button size="small" onClick={() => setRange([dayjs().subtract(1, 'month').startOf('month'), dayjs().subtract(1, 'month').endOf('month')])}>
              last month
            </Button>
          </Space>
        }
      >
        <Space wrap size="large" style={{ marginBottom: 12 }}>
          <Statistic title="Workers" value={totals.workers} valueStyle={{ fontSize: 18 }} />
          <Statistic title="Employee share (₹)" value={num(totals.employee, 0)} valueStyle={{ fontSize: 18, color: '#d46b08' }} />
          <Statistic title="Employer share (₹)" value={num(totals.employer, 0)} valueStyle={{ fontSize: 18, color: '#cf1322' }} />
          <Statistic title="Total liability (₹)" value={num(totals.total, 0)} valueStyle={{ fontSize: 18 }} />
          <Button type="primary" disabled={totals.total <= 0} onClick={() => setConfirming(true)}>
            Post this liability
          </Button>
        </Space>

        <Table
          rowKey="workerId"
          size="small"
          loading={isLoading}
          dataSource={rows}
          pagination={{ pageSize: 25 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nobody covered by a levy earned wages in this period" /> }}
          rowSelection={{
            selectedRowKeys: includedRows.map((r) => r.workerId),
            onChange: (keys) => setExcluded(new Set(rows.filter((r) => !keys.includes(r.workerId)).map((r) => r.workerId))),
            // `name` so each selection box is an identifiable form field rather than an
            // anonymous one — antd passes these straight through to the checkbox.
            getCheckboxProps: (r) => ({
              name: `statutory-include-${r.workerId}`,
              disabled: Object.values(r.cells).every((c) => c.alreadyPosted || !c.covered),
            }),
          }}
          columns={[
            {
              title: 'Worker',
              dataIndex: 'name',
              render: (v, r) => (
                <span>
                  <Link to={`/manforce/workers/${r.workerId}`}>{v}</Link>
                  <br />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {r.code}
                    {r.contractorName ? ` · ${r.contractorName}` : ''}
                  </Text>
                </span>
              ),
            },
            { title: 'Wage base', dataIndex: 'wages', width: 120, align: 'right', render: (v) => money(v, '₹', 0) },
            ...(preview?.components ?? []).map((c) => ({
              title: (
                <Tooltip title={c.isProvision ? 'A provision — accrued as a cost, not owed to anyone until declared.' : undefined}>
                  <span>
                    {c.code}
                    {c.isProvision ? ' *' : ''}
                  </span>
                </Tooltip>
              ),
              key: `c${c.id}`,
              width: 150,
              align: 'right' as const,
              render: (_: unknown, r: (typeof rows)[number]) => {
                const cell = r.cells[c.id];
                if (!cell) return '';
                if (cell.alreadyPosted) return <Tag color="blue">posted</Tag>;
                if (!cell.covered)
                  return (
                    <Tooltip title={cell.reason}>
                      <Text type="secondary">—</Text>
                    </Tooltip>
                  );
                return (
                  <span>
                    {money(cell.employee, '₹', 0)}
                    <br />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      + {money(cell.employer, '₹', 0)} employer
                    </Text>
                  </span>
                );
              },
            })),
          ]}
        />
        <Text type="secondary">
          The employee share is deducted from what the worker is owed; the employer share is the factory's own cost. Both are posted to the levy's account and settled from Payments.
        </Text>
      </Card>

      <Card size="small" title="Postings" style={{ marginTop: 16 }}>
        <Table
          rowKey="id"
          size="small"
          dataSource={postings ?? []}
          pagination={false}
          locale={{ emptyText: 'Nothing posted yet' }}
          columns={[
            { title: 'Number', dataIndex: 'number', width: 120 },
            { title: 'Period', key: 'period', width: 220, render: (_, p) => `${dayjs(p.periodFrom).format('DD MMM YY')} — ${dayjs(p.periodTo).format('DD MMM YY')}` },
            { title: 'Levies', dataIndex: 'components', render: (v: string[]) => v.map((c) => <Tag key={c}>{c}</Tag>) },
            { title: 'Workers', dataIndex: 'workers', width: 90, align: 'right' },
            { title: 'Employee', dataIndex: 'employee', width: 120, align: 'right', render: (v) => money(v, '₹', 0) },
            { title: 'Employer', dataIndex: 'employer', width: 120, align: 'right', render: (v) => money(v, '₹', 0) },
            { title: 'Total', dataIndex: 'total', width: 130, align: 'right', render: (v) => <b>{money(v, '₹', 0)}</b> },
            { title: 'Posted', dataIndex: 'postedOn', width: 120, render: (d) => dayjs(d).format('DD MMM YY') },
            {
              title: '',
              key: 'x',
              width: 50,
              render: (_, p) => (
                <Popconfirm
                  title="Reverse this posting?"
                  description="The liability and the workers' deductions go with it. Refused if anything has already been paid against those levies."
                  onConfirm={() => reverse.mutate(p.id)}
                >
                  <Button size="small" danger type="text" icon={<DeleteOutlined />} />
                </Popconfirm>
              ),
            },
          ]}
        />
      </Card>

      <Card size="small" title="How each levy is set up" style={{ marginTop: 16 }} extra={<Link to="/settings/masters">edit in Master Data</Link>}>
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={components ?? []}
          columns={[
            { title: 'Code', dataIndex: 'code', width: 90 },
            { title: 'Name', dataIndex: 'name' },
            {
              title: 'Rate',
              key: 'rate',
              width: 220,
              render: (_, c) =>
                c.flatAmount > 0 ? `flat ₹${num(c.flatAmount, 0)}` : `${num(c.employeePct, 2)}% employee + ${num(c.employerPct, 2)}% employer`,
            },
            { title: 'On', dataIndex: 'basis', width: 130, render: (v) => (v === 'BASIC' ? 'wages, no overtime' : 'all wages') },
            {
              title: 'Ceilings',
              key: 'ceil',
              render: (_, c) =>
                [c.wageCeiling ? `capped at ₹${num(c.wageCeiling, 0)}` : null, c.eligibilityCeiling ? `out above ₹${num(c.eligibilityCeiling, 0)}` : null, c.minWages ? `from ₹${num(c.minWages, 0)}` : null]
                  .filter(Boolean)
                  .join(' · ') || '—',
            },
            { title: 'Payee', dataIndex: 'payeeName', width: 150, render: (v) => v || '—' },
            { title: 'Covers', dataIndex: 'covered', width: 90, align: 'right', render: (v) => `${v} worker(s)` },
            { title: '', key: 'p', width: 100, render: (_, c) => (c.isProvision ? <Tag>provision</Tag> : c.isActive ? <Tag color="green">active</Tag> : <Tag>off</Tag>) },
          ]}
        />
      </Card>

      <Modal
        open={confirming}
        title="Post the statutory liability"
        okText={`Post ${money(totals.total, '₹', 0)}`}
        confirmLoading={post.isPending}
        onOk={() => post.mutate()}
        onCancel={() => setConfirming(false)}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="This creates real money entries"
          description={`${totals.workers} worker(s) will have ${money(totals.employee, '₹', 0)} deducted from what they are owed, and ${money(
            totals.employer,
            '₹',
            0
          )} becomes the factory's cost. The period ${range[0].format('DD MMM')} — ${range[1].format('DD MMM YYYY')} will then be closed to further posting for these levies.`}
        />
        <Input.TextArea rows={2} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      </Modal>
    </div>
  );
}
