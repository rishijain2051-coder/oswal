import { useMemo, useState } from 'react';
import { Alert, App, Breadcrumb, Button, Card, Col, DatePicker, Empty, Form, Input, InputNumber, Modal, Row, Segmented, Space, Statistic, Table, Tag, Tooltip, Typography } from 'antd';
import { HomeOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api, apiError } from '../../api/client';
import { MANFORCE_KEYS, useContractors, useManforceSummary, useWorkers, type Worker } from '../../api/manforce';
import { usePayables, usePayments } from '../../api/ops';
import { useAuth } from '../../auth/AuthContext';
import { money, num } from '../../util/format';

const { Title, Text } = Typography;

/**
 * Wages: who is owed what, and paying them.
 *
 * There is no pay run to execute. Every figure is derived from attendance and the
 * board, and a payment is just cash leaving on a date — so this screen is a list of
 * balances with a way to settle any of them, in part or in full.
 */
export default function WagesPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const { can } = useAuth();
  const canManage = can('payments.record');

  const [scope, setScope] = useState<'workers' | 'gangs'>('workers');
  const [payTarget, setPayTarget] = useState<PayTarget | null>(null);

  const { data: summary } = useManforceSummary();
  const { data: workers } = useWorkers({ money: '1' });
  const { data: contractors } = useContractors();
  const { data: payables } = usePayables();
  const { data: recent } = usePayments({ partyType: scope === 'gangs' ? 'CONTRACTOR' : 'WORKER' });

  const contractorRows = useMemo(() => {
    const rows = (payables ?? []).filter((p) => p.partyType === 'CONTRACTOR');
    // A gang with no work yet still deserves a row, so it can be found and paid.
    for (const c of contractors ?? []) {
      if (!rows.some((r) => r.partyId === c.id)) {
        rows.push({ partyType: 'CONTRACTOR', partyId: c.id, supplierId: null, partyName: c.name, code: c.code, accrued: 0, paid: 0, balance: 0, credit: 0, pieces: 0, events: c.workers, jobs: [] });
      }
    }
    return rows;
  }, [payables, contractors]);

  const directWorkers = useMemo(() => (workers ?? []).filter((w) => !w.contractorId && w.money), [workers]);

  const pay = useMutation({
    mutationFn: (v: any) =>
      api.post('/payments', {
        partyType: payTarget!.type,
        ...(payTarget!.type === 'WORKER' ? { workerId: payTarget!.id } : { contractorId: payTarget!.id }),
        partyName: payTarget!.name,
        kind: 'PAYMENT',
        amount: v.amount,
        date: (v.date ?? dayjs()).toISOString(),
        ref: v.ref || null,
        note: v.note || (payTarget!.type === 'CONTRACTOR' ? 'Paid to contractor' : 'Wages paid'),
      }),
    onSuccess: () => {
      message.success('Payment recorded.');
      for (const k of MANFORCE_KEYS) qc.invalidateQueries({ queryKey: k });
      setPayTarget(null);
    },
    onError: (e) => message.error(apiError(e)),
  });

  const openPay = (type: 'WORKER' | 'CONTRACTOR', id: number, name: string, due: number) => {
    setPayTarget({ type, id, name, due });
  };

  return (
    <div>
      <Breadcrumb style={{ marginBottom: 16 }} items={[{ title: <Link to="/"><HomeOutlined /></Link> }, { title: <Link to="/manforce">Manforce</Link> }, { title: 'Wages' }]} />
      <Title level={2} style={{ marginBottom: 2 }}>
        Wages &amp; advances
      </Title>
      <Text type="secondary">Nothing is on a cycle. Pay any amount on any day; the balance follows.</Text>

      <Row gutter={[16, 16]} style={{ margin: '16px 0' }}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Owed to workers (₹)" value={num(summary?.money?.workerDue ?? 0, 0)} valueStyle={{ color: '#cf1322' }} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Owed to gangs (₹)" value={num(summary?.money?.contractorDue ?? 0, 0)} valueStyle={{ color: '#cf1322' }} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Advances outstanding (₹)" value={num(summary?.money?.advanceOutstanding ?? 0, 0)} valueStyle={{ color: '#d4380d' }} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Paid out so far (₹)" value={num(summary?.money?.wagesPaid ?? 0, 0)} valueStyle={{ color: '#237804' }} />
          </Card>
        </Col>
      </Row>

      <Segmented
        value={scope}
        onChange={(v) => setScope(v as 'workers' | 'gangs')}
        options={[
          { label: `Workers (${directWorkers.length})`, value: 'workers' },
          { label: `Contractors (${contractorRows.length})`, value: 'gangs' },
        ]}
        style={{ marginBottom: 16 }}
      />

      {scope === 'workers' ? (
        <Table<Worker>
          rowKey="id"
          size="small"
          dataSource={directWorkers}
          pagination={{ pageSize: 25 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No directly-paid workers yet" /> }}
          columns={[
            {
              title: 'Worker',
              dataIndex: 'name',
              render: (_, w) => (
                <span>
                  <Link to={`/manforce/workers/${w.id}`}>{w.name}</Link>
                  <br />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {w.code}
                    {w.trade ? ` · ${w.trade.name}` : ''}
                  </Text>
                </span>
              ),
            },
            { title: 'Earned', key: 'earned', width: 120, align: 'right', render: (_, w) => money(w.money!.earned, '₹', 0) },
            { title: 'Paid', key: 'paid', width: 120, align: 'right', render: (_, w) => money(w.money!.paid + w.money!.advanced, '₹', 0) },
            {
              title: (
                <Tooltip title="What can be handed over today, after each advance's monthly recovery.">
                  <span>Due now</span>
                </Tooltip>
              ),
              key: 'due',
              width: 130,
              align: 'right',
              render: (_, w) => <b style={{ color: w.money!.dueNow > 0 ? '#cf1322' : '#237804' }}>{money(w.money!.dueNow, '₹', 0)}</b>,
            },
            {
              title: 'Advance out',
              key: 'adv',
              width: 130,
              align: 'right',
              render: (_, w) => (w.money!.advanceOutstanding ? <Tag color="volcano">{money(w.money!.advanceOutstanding, '₹', 0)}</Tag> : ''),
            },
            {
              title: '',
              key: 'x',
              width: 190,
              render: (_, w) => (
                <Space>
                  {canManage && (
                    <Button size="small" type="primary" onClick={() => openPay('WORKER', w.id, w.name, w.money!.dueNow)}>
                      Pay
                    </Button>
                  )}
                  <Button size="small" onClick={() => navigate(`/finance/payments/worker/${w.id}`)}>
                    Statement
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      ) : (
        <Table
          rowKey={(r) => r.partyId ?? r.partyName}
          size="small"
          dataSource={contractorRows}
          pagination={false}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No contractors yet — add one in Master Data" /> }}
          expandable={{
            expandedRowRender: (r) => (
              <Table
                rowKey="orderNumber"
                size="small"
                pagination={false}
                dataSource={r.jobs}
                columns={[
                  { title: 'Worker', dataIndex: 'orderNumber' },
                  { title: 'Did', dataIndex: 'product', render: (v, j) => `${v}${j.pieces ? ` · ${j.pieces} pc` : ''}` },
                  { title: 'Earned', dataIndex: 'amount', width: 120, align: 'right', render: (v) => money(v, '₹', 0) },
                  { title: 'Their share', dataIndex: 'balance', width: 130, align: 'right', render: (v) => money(v, '₹', 0) },
                ]}
              />
            ),
            rowExpandable: (r) => r.jobs.length > 0,
          }}
          columns={[
            {
              title: 'Contractor',
              dataIndex: 'partyName',
              render: (v, r) => (
                <span>
                  {v}
                  <br />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {r.code} · {r.events} worker(s)
                  </Text>
                </span>
              ),
            },
            { title: 'Gang earned', dataIndex: 'accrued', width: 130, align: 'right', render: (v) => money(v, '₹', 0) },
            { title: 'Paid', dataIndex: 'paid', width: 120, align: 'right', render: (v) => money(v, '₹', 0) },
            { title: 'Balance', dataIndex: 'balance', width: 130, align: 'right', render: (v) => <b style={{ color: v > 0 ? '#cf1322' : '#237804' }}>{money(v, '₹', 0)}</b> },
            {
              title: '',
              key: 'x',
              width: 190,
              render: (_, r) => (
                <Space>
                  {canManage && (
                    <Button size="small" type="primary" onClick={() => openPay('CONTRACTOR', r.partyId!, r.partyName, r.balance)}>
                      Pay
                    </Button>
                  )}
                  <Button size="small" onClick={() => navigate(`/finance/payments/contractor/${r.partyId}`)}>
                    Statement
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      )}

      <Card size="small" title="Recent payments" style={{ marginTop: 16 }}>
        <Table
          rowKey="id"
          size="small"
          dataSource={(recent ?? []).slice(0, 20)}
          pagination={false}
          locale={{ emptyText: 'Nothing paid yet' }}
          columns={[
            { title: 'Date', dataIndex: 'date', width: 120, render: (d) => dayjs(d).format('DD MMM YY') },
            { title: 'Paid to', dataIndex: 'partyName' },
            { title: 'Amount', dataIndex: 'amount', width: 130, align: 'right', render: (v) => money(v, '₹', 0) },
            { title: 'Reference', dataIndex: 'ref', width: 160, render: (v) => v ?? '' },
            { title: 'Note', dataIndex: 'note', render: (v) => v ?? '' },
          ]}
        />
      </Card>

      {payTarget && <PayPartyModal target={payTarget} saving={pay.isPending} onCancel={() => setPayTarget(null)} onSubmit={(v) => pay.mutate(v)} />}
    </div>
  );
}

type PayTarget = { type: 'WORKER' | 'CONTRACTOR'; id: number; name: string; due: number };

/**
 * Recording a payment against a worker or a gang.
 *
 * This is its own component, and the page renders it only while a target is chosen, so
 * `useForm` and the `<Form>` it belongs to come into existence together. Kept on the page
 * with the form inside a closed modal, the instance sat unconnected — which is what antd
 * was warning about, and why seeding the amount from the click handler wrote to nothing
 * and the field opened blank. Mounting them together also makes `initialValues` the
 * natural place for the seed: it is evaluated once, on the open.
 */
function PayPartyModal({ target, saving, onCancel, onSubmit }: { target: PayTarget; saving: boolean; onCancel: () => void; onSubmit: (v: { amount: number; date?: dayjs.Dayjs; ref?: string; note?: string }) => void }) {
  const [form] = Form.useForm();
  return (
    <Modal open title={`Pay ${target.name}`} onCancel={onCancel} okText="Record payment" confirmLoading={saving} onOk={() => form.submit()}>
      {target.due <= 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="Nothing is outstanding"
          description="Paying anyway leaves them in credit — the amount is carried against future earnings rather than showing as a negative debt."
        />
      )}
      {/* Seeded with what is actually owed. Left blank when nothing is outstanding,
          because then there is no figure worth suggesting. */}
      <Form form={form} layout="vertical" initialValues={{ amount: target.due > 0 ? target.due : undefined, date: dayjs(), ref: '', note: '' }} onFinish={onSubmit}>
        <Form.Item name="amount" label="Amount (₹)" rules={[{ required: true, message: 'How much?' }]}>
          <InputNumber min={0.01} style={{ width: '100%' }} autoFocus />
        </Form.Item>
        <Form.Item name="date" label="Date" rules={[{ required: true }]}>
          <DatePicker style={{ width: '100%' }} format="DD MMM YYYY" />
        </Form.Item>
        <Form.Item name="ref" label="Reference">
          <Input placeholder="Voucher or UPI reference" />
        </Form.Item>
        <Form.Item name="note" label="Note">
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
