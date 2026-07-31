import { useState } from 'react';
import { Alert, App, Breadcrumb, Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Progress, Row, Select, Space, Statistic, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { HomeOutlined, PlusOutlined, DeleteOutlined, WalletOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import type { ColumnsType } from 'antd/es/table';
import { api, apiError } from '../../api/client';
import ForexSummaryCard from '../../components/ForexSummaryCard';
import TrashDrawer, { TrashButton } from '../../components/TrashDrawer';
import { OPS_KEYS, useFinanceParties, useFinanceSummary, useOrders, usePayables, usePayments, useReceivables, useSuppliers, type AllocatedPayment, type LedgerEntry, type Payable, type PartyRow, type Receivable } from '../../api/ops';
import { useBuyers } from '../../api/hooks';
import { useContractors, useStatutoryComponents, useWorkers } from '../../api/manforce';
import { useAuth } from '../../auth/AuthContext';
import { money } from '../../util/format';

const { Title, Text } = Typography;
const PARTY_COLOR: Record<string, string> = { SUPPLIER: 'brown', JOBWORK: 'volcano', BUYER: 'green', WORKER: 'blue', CONTRACTOR: 'geekblue', STATUTORY: 'purple' };
const PARTY_LABEL: Record<string, string> = {
  SUPPLIER: 'Material supplier',
  JOBWORK: 'Jobwork vendor',
  BUYER: 'Buyer',
  WORKER: 'Worker',
  CONTRACTOR: 'Labour contractor',
  STATUTORY: 'Statutory levy',
};

/**
 * Money, worked out rather than typed in.
 *
 * Receivables come from order values less the receipts booked against them, and
 * jobwork payables from the pieces each vendor actually cleared. Only material
 * bills and wages are entered by hand, because nothing else knows them.
 */
export default function PaymentsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const { can } = useAuth();
  const [trashOpen, setTrashOpen] = useState(false);
  const { data: summary } = useFinanceSummary();
  const { data: receivableData, isLoading: loadingR } = useReceivables();
  const { data: payables, isLoading: loadingP } = usePayables();
  const { data: parties, isLoading: loadingParties } = useFinanceParties();
  const { data: entries, isLoading: loadingE } = usePayments();
  const { data: suppliers } = useSuppliers();
  const { data: buyers } = useBuyers();
  const { data: orders } = useOrders();
  const { data: workers } = useWorkers({ active: '1' });
  const { data: contractors } = useContractors();
  const { data: components } = useStatutoryComponents();
  const [form] = Form.useForm();
  const [open, setOpen] = useState(false);
  const [ptype, setPtype] = useState('BUYER');

  const refresh = () => {
    for (const key of OPS_KEYS) qc.invalidateQueries({ queryKey: key });
  };

  const save = useMutation({
    mutationFn: (v: any) => {
      const supplierId = ['SUPPLIER', 'JOBWORK'].includes(v.partyType) ? v.partyRef : null;
      const buyerId = v.partyType === 'BUYER' ? v.partyRef : null;
      const workerId = v.partyType === 'WORKER' ? v.partyRef ?? null : null;
      const contractorId = v.partyType === 'CONTRACTOR' ? v.partyRef ?? null : null;
      const statutoryComponentId = v.partyType === 'STATUTORY' ? v.partyRef ?? null : null;
      let partyName = v.partyName;
      if (supplierId) partyName = suppliers?.find((s) => s.id === supplierId)?.name ?? partyName;
      if (buyerId) partyName = buyers?.find((b) => b.id === buyerId)?.name ?? partyName;
      if (workerId) partyName = workers?.find((w) => w.id === workerId)?.name ?? partyName;
      if (contractorId) partyName = contractors?.find((c) => c.id === contractorId)?.name ?? partyName;
      if (statutoryComponentId) {
        const c = components?.find((x) => x.id === statutoryComponentId);
        partyName = c ? c.payeeName || c.code : partyName;
      }
      return api.post('/payments', {
        partyType: v.partyType,
        supplierId,
        buyerId,
        workerId,
        contractorId,
        statutoryComponentId,
        orderId: v.orderId ?? null,
        partyName,
        kind: v.kind,
        amount: v.amount,
        ref: v.ref || null,
        note: v.note || null,
        date: v.date ? v.date.toISOString() : undefined,
      });
    },
    onSuccess: () => {
      message.success('Recorded.');
      setOpen(false);
      form.resetFields();
      refresh();
    },
    onError: (e) => message.error(apiError(e)),
  });

  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/payments/${id}`),
    onSuccess: () => {
      message.success('Deleted.');
      refresh();
    },
    onError: (e) => message.error(apiError(e)),
  });

  const openForm = (partyType: string, kind: 'BILL' | 'PAYMENT', orderId?: number, partyRef?: number, partyName?: string) => {
    form.resetFields();
    setPtype(partyType);
    form.setFieldsValue({ partyType, kind, date: dayjs(), orderId, partyRef, partyName });
    setOpen(true);
  };

  // Receipts must land on an order; jobwork/material payments may optionally.
  const buyerReceipt = ptype === 'BUYER';
  const kindLocked = buyerReceipt || ptype === 'JOBWORK';

  const receivableCols: ColumnsType<Receivable> = [
    { title: 'Order', dataIndex: 'orderNumber', width: 150, render: (n, r) => <Link to={`/operations/orders/${r.orderId}`} style={{ fontWeight: 600 }}>{n}</Link> },
    { title: 'Buyer', dataIndex: 'buyerName' },
    { title: 'Delivery', dataIndex: 'deliveryDate', width: 105, render: (d) => (d ? dayjs(d).format('DD MMM YY') : '—') },
    { title: 'Invoiced', dataIndex: 'invoiced', align: 'right', width: 130, render: (v, r) => money(v, r.symbol) },
    { title: 'Received', dataIndex: 'received', align: 'right', width: 130, render: (v, r) => <span style={{ color: '#237804' }}>{money(v, r.symbol)}</span> },
    {
      title: 'Still to collect',
      dataIndex: 'balance',
      align: 'right',
      width: 150,
      render: (v, r) => (
        <Tooltip title={r.exchangeRate !== 1 ? `≈ ${money(r.balanceInr, '₹')} at ${r.exchangeRate}` : undefined}>
          <b style={{ color: v > 0 ? '#cf1322' : '#237804' }}>{money(v, r.symbol)}</b>
        </Tooltip>
      ),
    },
    {
      title: 'Collected',
      key: 'pct',
      width: 110,
      render: (_, r) => {
        // An advance can exceed the order value, so cap the bar and say so instead
        // of drawing a nonsense percentage.
        const raw = r.invoiced > 0 ? Math.round((r.received / r.invoiced) * 100) : 0;
        return (
          <Tooltip title={raw > 100 ? `Paid ${money(r.received - r.invoiced, r.symbol)} more than invoiced — held on account` : undefined}>
            <Progress percent={Math.min(raw, 100)} size="small" strokeColor={raw > 100 ? '#1677ff' : '#237804'} format={() => (raw > 100 ? 'credit' : `${raw}%`)} />
          </Tooltip>
        );
      },
    },
    {
      title: '',
      key: 'a',
      width: 190,
      render: (_: unknown, r: Receivable) => (
        <Space>
          {can('payments.record') && (
            <Button size="small" onClick={() => openForm('BUYER', 'PAYMENT', r.orderId, r.buyerId)}>
              Receipt
            </Button>
          )}
          <Button size="small" type="link" onClick={() => navigate(`/finance/payments/buyer/${r.buyerId}`)}>
            Statement
          </Button>
        </Space>
      ),
    },
  ];

  const payableCols: ColumnsType<Payable> = [
    { title: 'Type', dataIndex: 'partyType', width: 150, render: (t) => <Tag color={PARTY_COLOR[t]}>{PARTY_LABEL[t] ?? t}</Tag> },
    {
      title: 'Party',
      dataIndex: 'partyName',
      render: (v, r) => (
        <span>
          {v}
          {r.unlinked && (
            <Tooltip title="A wage account still recorded against a typed name. Run npm run db:workers to turn it into a real worker record.">
              <Tag color="orange" style={{ marginLeft: 6 }}>
                not linked
              </Tag>
            </Tooltip>
          )}
          {r.isProvision && (
            <Tooltip title="A provision: accrued as a cost, but not owed to anyone until it is declared.">
              <Tag style={{ marginLeft: 6 }}>provision</Tag>
            </Tooltip>
          )}
        </span>
      ),
    },
    {
      title: 'Owed',
      dataIndex: 'accrued',
      align: 'right',
      width: 130,
      render: (v, r) => (
        <Tooltip
          title={
            r.partyType === 'JOBWORK'
              ? `${r.pieces} pc(s) cleared across ${r.jobs.length} job(s)`
              : r.partyType === 'WORKER'
                ? `Earned from attendance and the board across ${r.events} entry/entries`
                : r.partyType === 'CONTRACTOR'
                  ? `Earned by ${r.events} worker(s) in the gang`
                  : undefined
          }
        >
          <span>{money(v, '₹')}</span>
        </Tooltip>
      ),
    },
    { title: 'Paid', dataIndex: 'paid', align: 'right', width: 130, render: (v) => <span style={{ color: '#237804' }}>{money(v, '₹')}</span> },
    {
      title: 'Balance',
      dataIndex: 'balance',
      align: 'right',
      width: 160,
      render: (v, r) => (
        <span>
          <b style={{ color: v > 0 ? '#cf1322' : v < 0 ? '#1677ff' : '#999' }}>{money(v, '₹')}</b>
          {(r.advanceOutstanding ?? 0) > 0 && (
            <Tooltip title="Advance handed over that their earnings have not yet absorbed. Due now is the balance plus this.">
              <Tag color="volcano" style={{ marginLeft: 6 }}>
                adv {money(r.advanceOutstanding!, '₹', 0)}
              </Tag>
            </Tooltip>
          )}
        </span>
      ),
    },
    {
      title: '',
      key: 'a',
      width: 180,
      render: (_: unknown, r: Payable) => (
        <Space>
          {can('payments.delete') && !r.unlinked && (
            <Button size="small" onClick={() => openForm(r.partyType, 'PAYMENT', undefined, r.partyId ?? undefined, r.partyName)}>
              Pay
            </Button>
          )}
          <Button
            size="small"
            type="link"
            onClick={() =>
              navigate(
                r.partyId != null
                  ? `/finance/payments/${r.partyType.toLowerCase()}/${r.partyId}`
                  : `/finance/payments/${r.partyType.toLowerCase()}/by-name?name=${encodeURIComponent(r.partyName)}`
              )
            }
          >
            Statement
          </Button>
        </Space>
      ),
    },
  ];

  const entryCols: ColumnsType<LedgerEntry> = [
    { title: 'Date', dataIndex: 'date', width: 100, render: (d) => dayjs(d).format('DD MMM YY') },
    { title: 'Type', dataIndex: 'partyType', width: 145, render: (t) => <Tag color={PARTY_COLOR[t]}>{PARTY_LABEL[t] ?? t}</Tag> },
    { title: 'Party', dataIndex: 'partyName' },
    { title: 'Order', dataIndex: 'order', width: 140, render: (o: LedgerEntry['order']) => (o ? <Link to={`/operations/orders/${o.id}`}>{o.number}</Link> : '—') },
    { title: 'Kind', dataIndex: 'kind', width: 90, render: (k) => <Tag color={k === 'BILL' ? 'orange' : 'green'}>{k === 'BILL' ? 'Bill' : 'Paid'}</Tag> },
    { title: 'Amount', dataIndex: 'amount', align: 'right', width: 140, render: (v, r) => money(v, r.currency === 'INR' || !r.currency ? '₹' : `${r.currency} `) },
    { title: 'Ref', dataIndex: 'ref', width: 130, render: (v) => v || '—' },
    { title: 'Note', dataIndex: 'note', render: (v) => v || '—' },
    ...(can('payments.record')
      ? [
          {
            title: '',
            key: 'x',
            width: 40,
            render: (_: unknown, r: LedgerEntry) => (
              <Popconfirm title="Delete this entry?" onConfirm={() => del.mutate(r.id)} okButtonProps={{ danger: true }}>
                <Button size="small" danger type="text" icon={<DeleteOutlined />} />
              </Popconfirm>
            ),
          },
        ]
      : []),
  ];

  const partyOptions = ['SUPPLIER', 'JOBWORK'].includes(ptype)
    ? (suppliers ?? []).filter((s) => (ptype === 'JOBWORK' ? s.type !== 'MATERIAL' : s.type !== 'JOBWORK')).map((s) => ({ label: `${s.code} · ${s.name}`, value: s.id }))
    : ptype === 'BUYER'
      ? (buyers ?? []).map((b) => ({ label: `${b.code} · ${b.name}`, value: b.id }))
      : ptype === 'WORKER'
        ? // A gang member is paid through their contractor, so they are not offered here.
          (workers ?? []).filter((w) => !w.contractorId).map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id }))
        : ptype === 'CONTRACTOR'
          ? (contractors ?? []).map((c) => ({ label: `${c.code} · ${c.name}`, value: c.id }))
          : ptype === 'STATUTORY'
            ? (components ?? []).filter((c) => !c.isProvision).map((c) => ({ label: `${c.code} · ${c.payeeName || c.name}`, value: c.id }))
            : [];

  const orderOptions = (orders ?? []).filter((o) => o.status !== 'Cancelled').map((o) => ({ label: `${o.number} — ${o.buyer.name} (${o.currency?.code ?? 'INR'})`, value: o.id }));

  return (
    <div>
      <Breadcrumb style={{ marginBottom: 16 }} items={[{ title: <Link to="/"><HomeOutlined /></Link> }, { title: <Link to="/finance">Finance</Link> }, { title: 'Payments' }]} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>
            Payments
          </Title>
          <Text type="secondary">Every balance is worked out from the orders and the production board. You only record money that actually moved.</Text>
        </div>
        <Space>
          {can('payments.restore') && <TrashButton endpoint="/payments" onClick={() => setTrashOpen(true)} />}
          {can('payments.record') && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openForm('BUYER', 'PAYMENT')}>
              Record money
            </Button>
          )}
        </Space>
      </div>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="To collect from buyers (₹)" value={money(summary?.receivableInr ?? 0, '₹')} valueStyle={{ fontSize: 20, color: '#237804' }} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              of {money(summary?.invoicedInr ?? 0, '₹')} invoiced
            </Text>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Owed out (₹)" value={money(summary?.payableInr ?? 0, '₹')} valueStyle={{ fontSize: 20, color: '#cf1322' }} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              jobwork + material + wages
            </Text>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Jobwork earned by vendors (₹)" value={money(summary?.jobworkAccrued ?? 0, '₹')} valueStyle={{ fontSize: 20 }} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {summary?.jobworkEvents ?? 0} clearance(s) · paid {money(summary?.jobworkPaid ?? 0, '₹')} · due {money(summary?.jobworkDue ?? 0, '₹')}
            </Text>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Net position (₹)"
              value={money((summary?.receivableInr ?? 0) - (summary?.payableInr ?? 0), '₹')}
              valueStyle={{ fontSize: 20, color: (summary?.receivableInr ?? 0) - (summary?.payableInr ?? 0) >= 0 ? '#237804' : '#cf1322' }}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              coming in minus going out
              {(summary?.buyerCreditInr ?? 0) > 0 ? ` · ${money(summary!.buyerCreditInr, '₹')} held on account` : ''}
            </Text>
          </Card>
        </Col>
      </Row>

      <Card size="small">
        <Tabs
          items={[
            {
              key: 'receivable',
              label: `To collect (${(receivableData?.rows ?? []).filter((r) => r.balance > 0).length})`,
              children: (
                <>
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="Receipts settle the oldest order first"
                    description="A buyer owes their order value less what has been received. A receipt clears the order it names, then any surplus rolls on to their next oldest unpaid order; anything still left over is held on account. Cancelled orders drop out."
                  />
                  {/* What is outstanding per currency, and what the rupee value has done
                      since each order was booked. */}
                  <div style={{ marginBottom: 12 }}>
                    <ForexSummaryCard />
                  </div>
                  {(receivableData?.credits ?? []).length > 0 && (
                    <Alert
                      type="success"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message="Money held on account"
                      description={
                        <Space direction="vertical" size={2}>
                          {(receivableData?.credits ?? []).map((c) => (
                            <span key={`${c.buyerId}-${c.currency}`}>
                              <b>{c.buyerName}</b> has paid {money(c.amount, c.symbol)} more than their outstanding orders — it will settle their next order automatically.
                            </span>
                          ))}
                        </Space>
                      }
                    />
                  )}
                  <Table<Receivable>
                    rowKey="orderId"
                    size="small"
                    loading={loadingR}
                    columns={receivableCols}
                    dataSource={receivableData?.rows ?? []}
                    pagination={{ pageSize: 15, hideOnSinglePage: true }}
                    scroll={{ x: 1100 }}
                    locale={{ emptyText: 'No live orders to collect against.' }}
                    expandable={{
                      rowExpandable: (r) => r.receipts.length > 0,
                      expandedRowRender: (r) => (
                        <Table
                          size="small"
                          rowKey="id"
                          pagination={false}
                          dataSource={r.receipts}
                          columns={[
                            { title: 'Received', dataIndex: 'date', width: 120, render: (d) => dayjs(d).format('DD MMM YY') },
                            { title: 'Ref', dataIndex: 'ref', width: 150, render: (v) => v || '—' },
                            { title: 'Applied here', dataIndex: 'amount', align: 'right', width: 140, render: (v: number) => <b>{money(v, r.symbol)}</b> },
                            {
                              title: 'Of receipt',
                              key: 'full',
                              render: (_, x: any) => (
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  {money(x.fullAmount, r.symbol)}
                                  {x.spreadAcross > 1 ? ` spread across ${x.spreadAcross} orders` : ''}
                                  {x.aimedAtOrder && x.aimedAtOrder !== r.orderNumber ? ` · originally booked to ${x.aimedAtOrder}` : ''}
                                </Text>
                              ),
                            },
                          ]}
                        />
                      ),
                    }}
                  />
                </>
              ),
            },
            {
              key: 'payable',
              label: `To pay (${(payables ?? []).filter((p) => p.balance > 0).length})`,
              children: (
                <>
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="Jobwork counts itself"
                    description="A vendor's earnings are the pieces they cleared × the rate on that stage, so the figure grows as work happens. Payments settle the oldest job first. Open a statement for the movement-by-movement detail."
                  />
                  <Table<Payable>
                    rowKey={(r) => `${r.partyType}:${r.supplierId ?? r.partyName}`}
                    size="small"
                    loading={loadingP}
                    columns={payableCols}
                    dataSource={payables ?? []}
                    pagination={false}
                    scroll={{ x: 800 }}
                    expandable={{
                      rowExpandable: (r) => r.jobs.length > 0,
                      expandedRowRender: (r) => (
                        <Table
                          size="small"
                          rowKey={(j) => `${j.orderId ?? j.orderNumber}-${j.product}-${j.stages.join()}`}
                          pagination={false}
                          dataSource={r.jobs}
                          columns={[
                            {
                              title: r.partyType === 'JOBWORK' ? 'Order' : 'Bill / order',
                              dataIndex: 'orderNumber',
                              width: 170,
                              render: (n, j: any) => (j.orderId ? <Link to={`/operations/orders/${j.orderId}`}>{n}</Link> : n),
                            },
                            ...(r.partyType === 'JOBWORK'
                              ? [
                                  { title: 'Item', dataIndex: 'product' },
                                  { title: 'Stages', dataIndex: 'stages', render: (v: string[]) => v.join(', ') },
                                  { title: 'Pieces', dataIndex: 'pieces', align: 'right' as const, width: 80 },
                                ]
                              : []),
                            { title: 'Owed', dataIndex: 'amount', align: 'right', width: 120, render: (v: number) => money(v, '₹') },
                            { title: 'Paid', dataIndex: 'paid', align: 'right', width: 120, render: (v: number) => <span style={{ color: '#237804' }}>{money(v, '₹')}</span> },
                            { title: 'Balance', dataIndex: 'balance', align: 'right', width: 120, render: (v: number) => <b style={{ color: v > 0 ? '#cf1322' : '#999' }}>{money(v, '₹')}</b> },
                          ]}
                        />
                      ),
                    }}
                    locale={{ emptyText: 'Nothing owed out yet.' }}
                  />
                </>
              ),
            },
            {
              key: 'parties',
              label: `Everyone (${parties?.length ?? 0})`,
              children: (
                <>
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="One account per party"
                    description="Open any row for a full running statement — every order or job that created the debt, every payment, and how each payment was split."
                  />
                  <Table<PartyRow>
                    rowKey={(r) => `${r.partyType}:${r.partyId ?? r.name}`}
                    size="small"
                    loading={loadingParties}
                    dataSource={parties ?? []}
                    pagination={false}
                    scroll={{ x: 800 }}
                    onRow={(r) => ({
                      style: { cursor: 'pointer' },
                      onClick: () =>
                        navigate(
                          r.partyId != null
                            ? `/finance/payments/${r.partyType.toLowerCase()}/${r.partyId}`
                            : `/finance/payments/${r.partyType.toLowerCase()}/by-name?name=${encodeURIComponent(r.name)}`
                        ),
                    })}
                    columns={[
                      { title: 'Type', dataIndex: 'partyType', width: 150, render: (t) => <Tag color={PARTY_COLOR[t]}>{PARTY_LABEL[t] ?? t}</Tag> },
                      {
                        title: 'Party',
                        dataIndex: 'name',
                        render: (v, r) => (
                          <span>
                            <Text strong>{v}</Text>
                            {r.code && (
                              <Text type="secondary" style={{ fontSize: 12 }}>
                                {' '}
                                {r.code}
                              </Text>
                            )}
                          </span>
                        ),
                      },
                      { title: 'Orders / bills', dataIndex: 'orders', align: 'right', width: 120 },
                      { title: 'Owes us (₹)', dataIndex: 'owesUs', align: 'right', width: 150, render: (v) => (v ? <b style={{ color: '#237804' }}>{money(v, '₹')}</b> : '—') },
                      { title: 'We owe (₹)', dataIndex: 'weOwe', align: 'right', width: 150, render: (v) => (v ? <b style={{ color: '#cf1322' }}>{money(v, '₹')}</b> : '—') },
                      {
                        title: 'On account',
                        dataIndex: 'credit',
                        align: 'right',
                        width: 140,
                        render: (v) =>
                          v ? (
                            <Tooltip title="Paid beyond what was outstanding — settles the next order or bill automatically">
                              <Tag color="purple">{money(v, '₹')}</Tag>
                            </Tooltip>
                          ) : (
                            '—'
                          ),
                      },
                      { title: '', key: 'go', width: 100, render: () => <Text type="secondary">Statement →</Text> },
                    ]}
                    locale={{ emptyText: 'No accounts yet.' }}
                  />
                </>
              ),
            },
            {
              key: 'entries',
              label: `Money moved (${entries?.length ?? 0})`,
              children: (
                <Table<LedgerEntry>
                  rowKey="id"
                  size="small"
                  loading={loadingE}
                  columns={entryCols}
                  dataSource={entries ?? []}
                  pagination={{ pageSize: 15, hideOnSinglePage: true }}
                  scroll={{ x: 1000 }}
                  locale={{ emptyText: 'Nothing recorded yet.' }}
                />
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title={
          <Space>
            <WalletOutlined /> Record money
          </Space>
        }
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
        okText="Record"
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} style={{ marginTop: 12 }}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="partyType" label="Who" rules={[{ required: true }]}>
                <Select
                  onChange={(v) => {
                    setPtype(v);
                    form.setFieldsValue({ partyRef: undefined, kind: v === 'BUYER' || v === 'JOBWORK' ? 'PAYMENT' : form.getFieldValue('kind') });
                  }}
                  options={Object.entries(PARTY_LABEL).map(([value, label]) => ({ label, value }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="kind" label="What" rules={[{ required: true }]} extra={kindLocked ? 'Calculated automatically — only the money movement is recorded.' : undefined}>
                <Select
                  disabled={kindLocked}
                  options={[
                    { label: buyerReceipt ? 'Receipt from buyer' : 'Payment made', value: 'PAYMENT' },
                    { label: 'Bill received (they owe us work done)', value: 'BILL', disabled: kindLocked },
                  ]}
                />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            name="partyRef"
            label={PARTY_LABEL[ptype]}
            rules={[{ required: true, message: 'Pick the party.' }]}
            extra={
              ptype === 'WORKER'
                ? 'Only workers the factory pays directly — a gang member is paid through their contractor.'
                : ptype === 'STATUTORY'
                  ? 'Settles what a posted levy owes the authority.'
                  : undefined
            }
          >
            <Select showSearch optionFilterProp="label" options={partyOptions} />
          </Form.Item>

          <Form.Item
            name="orderId"
            label="Against order"
            extra={
              buyerReceipt
                ? "Settles this order first, then rolls any surplus on to their next oldest unpaid order. Leave blank to just work oldest-first."
                : 'Optional — links the cost to an order.'
            }
          >
            <Select allowClear showSearch optionFilterProp="label" options={orderOptions} />
          </Form.Item>

          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="amount" label="Amount" rules={[{ required: true, message: 'How much?' }]}>
                <InputNumber min={0.01} step={0.01} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="date" label="Date">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="ref" label="Reference">
            <Input placeholder="e.g. cheque no, UTR, bill no" />
          </Form.Item>
          <Form.Item name="note" label="Note">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
      <TrashDrawer
        open={trashOpen}
        onClose={() => setTrashOpen(false)}
        title="Deleted money entries"
        endpoint="/payments"
        label="Entry"
        queryKeys={[['payments'], ['receivables'], ['payables'], ['finance-summary'], ['finance-parties'], ['statement'], ['ops-dashboard'], ['finance-receivables-summary']]}
        columns={[
          { title: 'Party', render: (r) => String(r.partyName) },
          { title: 'Kind', width: 90, render: (r) => String(r.kind) },
          { title: 'Amount', width: 130, render: (r) => `${String(r.currency ?? 'INR')} ${Number(r.amount).toLocaleString('en-IN')}` },
        ]}
      />
    </div>
  );
}
