import { App, Alert, Breadcrumb, Button, Card, Col, Descriptions, Empty, Result, Row, Skeleton, Space, Statistic, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { HomeOutlined, ArrowLeftOutlined, PrinterOutlined, ShopOutlined, InboxOutlined, TeamOutlined, UserOutlined, FileDoneOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import type { ColumnsType } from 'antd/es/table';
import { api, apiError } from '../../api/client';
import { OPS_KEYS, usePartyStatement, type AllocatedPayment, type JobworkEvent, type PartyType, type StatementRow } from '../../api/ops';
import { useAuth } from '../../auth/AuthContext';
import { money, num } from '../../util/format';

const { Title, Text } = Typography;

const PARTY_META: Record<PartyType, { label: string; icon: JSX.Element; owed: string; settle: string }> = {
  BUYER: { label: 'Buyer', icon: <UserOutlined />, owed: 'Owes us', settle: 'Receipt' },
  JOBWORK: { label: 'Jobwork vendor', icon: <ShopOutlined />, owed: 'We owe', settle: 'Payment' },
  SUPPLIER: { label: 'Material supplier', icon: <InboxOutlined />, owed: 'We owe', settle: 'Payment' },
  WORKER: { label: 'Worker', icon: <TeamOutlined />, owed: 'We owe', settle: 'Payment' },
  CONTRACTOR: { label: 'Labour contractor', icon: <TeamOutlined />, owed: 'We owe', settle: 'Payment' },
  STATUTORY: { label: 'Statutory levy', icon: <SafetyCertificateOutlined />, owed: 'We owe', settle: 'Payment' },
};

const TYPE_COLOR: Record<StatementRow['type'], string> = { ACCRUAL: 'gold', BILL: 'orange', INVOICE: 'blue', PAYMENT: 'green', RECEIPT: 'green' };

/** How a payment was split, shown wherever a payment appears. */
function AllocationTags({ p, symbol }: { p: AllocatedPayment; symbol: string }) {
  return (
    <Space size={4} wrap>
      {p.allocations.map((a) => (
        <Tag key={a.key} color="blue" style={{ margin: 0 }}>
          {a.label}: {money(a.amount, symbol)}
        </Tag>
      ))}
      {p.unallocated > 0 && (
        <Tooltip title="Nothing left outstanding to settle — held on account until the next order or bill">
          <Tag color="purple" style={{ margin: 0 }}>
            on account: {money(p.unallocated, symbol)}
          </Tag>
        </Tooltip>
      )}
      {p.allocations.length === 0 && p.unallocated === 0 && <Text type="secondary">—</Text>}
    </Space>
  );
}

function statementCols(symbol: string): ColumnsType<StatementRow> {
  return [
    { title: 'Date', dataIndex: 'date', width: 100, render: (d) => dayjs(d).format('DD MMM YY') },
    { title: 'What', dataIndex: 'type', width: 100, render: (t: StatementRow['type']) => <Tag color={TYPE_COLOR[t]}>{t === 'ACCRUAL' ? 'Work done' : t === 'RECEIPT' ? 'Received' : t === 'PAYMENT' ? 'Paid' : t === 'INVOICE' ? 'Order' : 'Bill'}</Tag> },
    {
      title: 'Detail',
      dataIndex: 'description',
      render: (v, r) => (
        <div>
          <div>{v}</div>
          {r.detail && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {r.detail}
            </Text>
          )}
        </div>
      ),
    },
    { title: 'Ref', dataIndex: 'ref', width: 130, render: (v) => v || '—' },
    { title: 'Charge', dataIndex: 'charge', align: 'right', width: 120, render: (v) => (v ? money(v, symbol) : '—') },
    { title: 'Settled', dataIndex: 'settle', align: 'right', width: 120, render: (v) => (v ? <span style={{ color: '#237804' }}>{money(v, symbol)}</span> : '—') },
    { title: 'Balance', dataIndex: 'balance', align: 'right', width: 130, render: (v) => <b style={{ color: v > 0 ? '#cf1322' : v < 0 ? '#1677ff' : '#999' }}>{money(v, symbol)}</b> },
  ];
}

/**
 * One party, fully accounted for: a running statement, the per-order split, the
 * detail behind every charge, and how each payment was spread.
 */
export default function PartyStatementPage() {
  const { partyType, partyId } = useParams<{ partyType: string; partyId: string }>();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { hasRole } = useAuth();

  const type = (partyType?.toUpperCase() ?? 'BUYER') as PartyType;
  const name = search.get('name') ?? undefined;
  const id = partyId && partyId !== 'by-name' ? Number(partyId) : undefined;
  const { data, isLoading, isError } = usePartyStatement(type, id, name);

  const billReceipt = useMutation({
    mutationFn: (r: { id: number; value: number; item: string }) =>
      api.post('/payments', {
        partyType: 'SUPPLIER',
        supplierId: id,
        stockTxnId: r.id,
        partyName: data?.party.name ?? 'Supplier',
        kind: 'BILL',
        amount: r.value,
        ref: `Receipt #${r.id}`,
        note: r.item,
      }),
    onSuccess: () => {
      message.success('Billed. It now shows in what we owe.');
      for (const key of OPS_KEYS) qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => message.error(apiError(e)),
  });

  if (isLoading) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (isError || !data) return <Result status="404" title="Party not found" extra={<Button onClick={() => navigate('/finance/payments')}>Back to Payments</Button>} />;

  const meta = PARTY_META[type];
  const isBuyer = type === 'BUYER';

  const header = (
    <div className="no-print">
      <Breadcrumb
        style={{ marginBottom: 16 }}
        items={[
          { title: <Link to="/"><HomeOutlined /></Link> },
          { title: <Link to="/finance">Finance</Link> },
          { title: <Link to="/finance/payments">Payments</Link> },
          { title: data.party.name },
        ]}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <Space wrap>
          <Title level={3} style={{ margin: 0 }}>
            {data.party.name}
          </Title>
          <Tag icon={meta.icon} color="#6d4c41">
            {meta.label}
          </Tag>
          {data.party.code && <Text type="secondary">{data.party.code}</Text>}
        </Space>
        <Space wrap>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/finance/payments')}>
            Back
          </Button>
          <Button icon={<PrinterOutlined />} onClick={() => window.print()}>
            Print statement
          </Button>
        </Space>
      </div>
      {(data.party.phone || data.party.email || data.party.gstNo || data.party.paymentTerms) && (
        <Card size="small" style={{ marginBottom: 16 }}>
          <Descriptions size="small" column={4}>
            {data.party.phone ? <Descriptions.Item label="Phone">{data.party.phone}</Descriptions.Item> : null}
            {data.party.email ? <Descriptions.Item label="E-mail">{data.party.email}</Descriptions.Item> : null}
            {data.party.gstNo ? <Descriptions.Item label="GSTIN">{data.party.gstNo}</Descriptions.Item> : null}
            {data.party.paymentTerms ? <Descriptions.Item label="Terms">{data.party.paymentTerms}</Descriptions.Item> : null}
          </Descriptions>
        </Card>
      )}
    </div>
  );

  // --- buyer: one statement per currency they trade in ---------------------
  if (isBuyer) {
    return (
      <div>
        {header}
        {(data.currencies ?? []).length === 0 ? (
          <Empty description="No orders for this buyer yet." />
        ) : (
          (data.currencies ?? []).map((c) => (
            <Card key={c.currency} size="small" style={{ marginBottom: 16 }} title={`In ${c.currency}`}>
              <Row gutter={[16, 12]} style={{ marginBottom: 12 }}>
                <Col xs={12} md={6}>
                  <Statistic title="Invoiced" value={money(c.invoiced, c.symbol)} valueStyle={{ fontSize: 18 }} />
                </Col>
                <Col xs={12} md={6}>
                  <Statistic title="Received" value={money(c.received, c.symbol)} valueStyle={{ fontSize: 18, color: '#237804' }} />
                </Col>
                <Col xs={12} md={6}>
                  <Statistic title="Still to collect" value={money(c.balance, c.symbol)} valueStyle={{ fontSize: 18, color: c.balance > 0 ? '#cf1322' : '#237804' }} />
                </Col>
                <Col xs={12} md={6}>
                  <Statistic title="Held on account" value={money(c.credit, c.symbol)} valueStyle={{ fontSize: 18, color: c.credit > 0 ? '#1677ff' : '#999' }} />
                </Col>
              </Row>

              <Tabs
                items={[
                  {
                    key: 'statement',
                    label: 'Statement',
                    children: <Table<StatementRow> rowKey="key" size="small" columns={statementCols(c.symbol)} dataSource={c.statement} pagination={false} scroll={{ x: 900 }} />,
                  },
                  {
                    key: 'orders',
                    label: `Orders (${c.orders.length})`,
                    children: (
                      <Table
                        rowKey="orderId"
                        size="small"
                        pagination={false}
                        dataSource={c.orders}
                        columns={[
                          { title: 'Order', dataIndex: 'orderNumber', width: 150, render: (n, r: any) => <Link to={`/operations/orders/${r.orderId}`}>{n}</Link> },
                          { title: 'Date', dataIndex: 'date', width: 110, render: (d) => dayjs(d).format('DD MMM YY') },
                          { title: 'Status', dataIndex: 'status', width: 110, render: (s) => <Tag>{s}</Tag> },
                          { title: 'Value', dataIndex: 'gross', align: 'right', width: 140, render: (v) => money(v, c.symbol) },
                          { title: 'Received', dataIndex: 'paid', align: 'right', width: 140, render: (v) => <span style={{ color: '#237804' }}>{money(v, c.symbol)}</span> },
                          { title: 'Balance', dataIndex: 'balance', align: 'right', width: 140, render: (v) => <b style={{ color: v > 0 ? '#cf1322' : '#999' }}>{money(v, c.symbol)}</b> },
                        ]}
                      />
                    ),
                  },
                  {
                    key: 'receipts',
                    label: `Receipts (${c.receipts.length})`,
                    children: (
                      <>
                        <Alert
                          type="info"
                          showIcon
                          style={{ marginBottom: 12 }}
                          message="Receipts settle the oldest order first"
                          description="A receipt clears the order it names, then any surplus rolls on to the next oldest order still outstanding. Whatever is left over is held on account."
                        />
                        <Table
                          rowKey="id"
                          size="small"
                          pagination={false}
                          dataSource={c.receipts}
                          columns={[
                            { title: 'Date', dataIndex: 'date', width: 110, render: (d) => dayjs(d).format('DD MMM YY') },
                            { title: 'Amount', dataIndex: 'amount', align: 'right', width: 140, render: (v) => <b>{money(v, c.symbol)}</b> },
                            { title: 'Ref', dataIndex: 'ref', width: 140, render: (v) => v || '—' },
                            { title: 'Applied to', key: 'alloc', render: (_, r: AllocatedPayment) => <AllocationTags p={r} symbol={c.symbol} /> },
                          ]}
                        />
                      </>
                    ),
                  },
                ]}
              />
            </Card>
          ))
        )}
      </div>
    );
  }

  // --- vendor / supplier / worker / contractor / statutory ------------------
  const s = data.summary!;
  const symbol = '₹';
  const isJobwork = type === 'JOBWORK';
  /** Extra figures the workforce parties carry — derived, so only they have them. */
  const wf = data.workforce;

  const eventCols: ColumnsType<JobworkEvent> = [
    { title: 'Date', dataIndex: 'date', width: 100, render: (d) => dayjs(d).format('DD MMM YY') },
    { title: 'Order', dataIndex: 'orderNumber', width: 140, render: (n, r) => <Link to={`/operations/orders/${r.orderId}`}>{n}</Link> },
    { title: 'Item', key: 'item', render: (_, r) => <span>{r.productCode} <Text type="secondary" style={{ fontSize: 12 }}>{r.productName}</Text></span> },
    { title: 'Stage', dataIndex: 'stage', width: 150, render: (v, r) => <span><Tag>{r.stageSortOrder + 1}</Tag>{v}</span> },
    { title: 'Pieces', dataIndex: 'pieces', align: 'right', width: 80 },
    { title: 'Rate', dataIndex: 'rate', align: 'right', width: 90, render: (v) => `${symbol}${num(v, 2)}` },
    { title: 'Earned', dataIndex: 'amount', align: 'right', width: 120, render: (v) => <b>{money(v, symbol)}</b> },
    {
      title: 'Note',
      dataIndex: 'note',
      render: (v, r) => (
        <Space size={4} wrap>
          {r.rework && (
            <Tooltip title="These pieces had been rejected and were done again — paid again, because the work was done again">
              <Tag color="red">re-done</Tag>
            </Tooltip>
          )}
          {v ? <Text style={{ fontSize: 12 }}>{v}</Text> : !r.rework ? <Text type="secondary">—</Text> : null}
        </Space>
      ),
    },
  ];

  return (
    <div>
      {header}

      <Card size="small" style={{ marginBottom: 16 }} className="no-print">
        <Row gutter={[16, 12]}>
          <Col xs={12} md={5}>
            <Statistic title={isJobwork ? 'Earned by them' : 'Billed to us'} value={money(s.accrued, symbol)} valueStyle={{ fontSize: 18 }} />
            {isJobwork && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {s.pieces} pcs over {s.events} clearance(s)
              </Text>
            )}
          </Col>
          <Col xs={12} md={5}>
            <Statistic title="Paid" value={money(s.paid, symbol)} valueStyle={{ fontSize: 18, color: '#237804' }} />
          </Col>
          <Col xs={12} md={5}>
            <Statistic title="Still to pay" value={money(s.balance, symbol)} valueStyle={{ fontSize: 18, color: s.balance > 0 ? '#cf1322' : '#237804' }} />
          </Col>
          <Col xs={12} md={5}>
            <Statistic title="Paid in advance" value={money(s.credit, symbol)} valueStyle={{ fontSize: 18, color: s.credit > 0 ? '#1677ff' : '#999' }} />
          </Col>
          {type === 'SUPPLIER' && (data.unbilledValue ?? 0) > 0 && (
            <Col xs={12} md={4}>
              <Statistic title="Delivered, not billed" value={money(data.unbilledValue ?? 0, symbol)} valueStyle={{ fontSize: 18, color: '#874d00' }} />
            </Col>
          )}
          {wf?.dueNow != null && (
            <Col xs={12} md={4}>
              <Tooltip title="What can be handed over today, after each advance's monthly recovery. Due now less the advance outstanding is exactly the balance.">
                <Statistic title="Due now" value={money(wf.dueNow, symbol)} valueStyle={{ fontSize: 18, color: wf.dueNow > 0 ? '#cf1322' : '#237804' }} />
              </Tooltip>
            </Col>
          )}
          {(wf?.advanceOutstanding ?? 0) > 0 && (
            <Col xs={12} md={4}>
              <Statistic title="Advance outstanding" value={money(wf!.advanceOutstanding!, symbol)} valueStyle={{ fontSize: 18, color: '#d4380d' }} />
            </Col>
          )}
        </Row>
        {wf && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {type === 'WORKER' &&
              `Earned from attendance and the board — nothing here was typed in.${wf.earnedDays ? ` ${num(wf.earnedDays, 1)} day(s) paid.` : ''}${
                wf.deducted ? ` ${money(wf.deducted, symbol)} deducted.` : ''
              }${wf.statutoryDeducted ? ` ${money(wf.statutoryDeducted, symbol)} statutory.` : ''}${wf.contractor ? ` Paid through ${wf.contractor}.` : ''}`}
            {type === 'CONTRACTOR' && `Rolled up from ${wf.gang ?? 0} worker(s) in the gang. One payment settles the lot; the breakdown below explains it.`}
            {type === 'STATUTORY' &&
              `${money(wf.employee ?? 0, symbol)} deducted from workers plus ${money(wf.employer ?? 0, symbol)} of the factory's own cost, over ${wf.workersCovered ?? 0} worker(s).${
                wf.isProvision ? ' A provision — owed to nobody until declared.' : ''
              }`}
          </Text>
        )}
      </Card>

      <Card size="small">
        <Tabs
          items={[
            {
              key: 'statement',
              label: 'Statement',
              children: <Table<StatementRow> rowKey="key" size="small" columns={statementCols(symbol)} dataSource={data.statement ?? []} pagination={false} scroll={{ x: 950 }} />,
            },
            ...(isJobwork
              ? [
                  {
                    key: 'events',
                    label: `Work done (${data.events?.length ?? 0})`,
                    children: (
                      <>
                        <Alert
                          type="info"
                          showIcon
                          style={{ marginBottom: 12 }}
                          message="Every clearance, priced"
                          description="A vendor earns each time pieces leave a stage they own — pieces × the rate on that stage. Pieces rejected and re-done earn again, because the work was done again."
                        />
                        <Table<JobworkEvent>
                          rowKey="moveId"
                          size="small"
                          columns={eventCols}
                          dataSource={data.events ?? []}
                          pagination={{ pageSize: 20, hideOnSinglePage: true }}
                          scroll={{ x: 1000 }}
                          summary={(rows) => (
                            <Table.Summary.Row>
                              <Table.Summary.Cell index={0} colSpan={4}>
                                <b>Total</b>
                              </Table.Summary.Cell>
                              <Table.Summary.Cell index={4} align="right">
                                <b>{rows.reduce((a, r) => a + r.pieces, 0)}</b>
                              </Table.Summary.Cell>
                              <Table.Summary.Cell index={5} />
                              <Table.Summary.Cell index={6} align="right">
                                <b>{money(rows.reduce((a, r) => a + r.amount, 0), symbol)}</b>
                              </Table.Summary.Cell>
                              <Table.Summary.Cell index={7} />
                            </Table.Summary.Row>
                          )}
                        />
                      </>
                    ),
                  },
                ]
              : []),
            ...(type === 'SUPPLIER'
              ? [
                  {
                    key: 'supplied',
                    label: `Delivered (${data.supplied?.length ?? 0})`,
                    children: (
                      <>
                        <Alert
                          type="info"
                          showIcon
                          style={{ marginBottom: 12 }}
                          message="Deliveries and their bills are kept apart on purpose"
                          description="Stock records what physically arrived; a bill records what they charged. Bill a delivery to bring it into what we owe — that way nothing is counted twice."
                        />
                        <Table
                          rowKey="id"
                          size="small"
                          pagination={{ pageSize: 20, hideOnSinglePage: true }}
                          dataSource={data.supplied ?? []}
                          columns={[
                            { title: 'Date', dataIndex: 'date', width: 110, render: (d) => dayjs(d).format('DD MMM YY') },
                            { title: 'Item', dataIndex: 'item' },
                            { title: 'Qty', key: 'qty', align: 'right', width: 110, render: (_, r: any) => `${num(r.qty, 3)} ${r.unit}` },
                            { title: 'Rate', dataIndex: 'rate', align: 'right', width: 100, render: (v) => money(v, symbol) },
                            { title: 'Value', dataIndex: 'value', align: 'right', width: 130, render: (v) => <b>{money(v, symbol)}</b> },
                            {
                              title: 'Billed',
                              key: 'billed',
                              width: 150,
                              render: (_, r: any) =>
                                r.billed ? (
                                  <Tag color="green">billed</Tag>
                                ) : hasRole('Manager') ? (
                                  <Button size="small" loading={billReceipt.isPending} onClick={() => billReceipt.mutate({ id: r.id, value: r.value, item: r.item })}>
                                    Bill {money(r.value, symbol)}
                                  </Button>
                                ) : (
                                  <Tag color="orange">not billed</Tag>
                                ),
                            },
                          ]}
                        />
                      </>
                    ),
                  },
                ]
              : []),
            {
              key: 'perOrder',
              label: `By order (${data.perOrder?.length ?? 0})`,
              children: (
                <Table
                  rowKey={(r: any) => `${r.orderId ?? r.orderNumber}`}
                  size="small"
                  pagination={false}
                  dataSource={data.perOrder ?? []}
                  columns={[
                    {
                      title: isJobwork ? 'Order' : 'Bill / order',
                      dataIndex: 'orderNumber',
                      render: (n, r: any) => (r.orderId ? <Link to={`/operations/orders/${r.orderId}`}>{n}</Link> : n),
                    },
                    ...(isJobwork ? [{ title: 'Pieces', dataIndex: 'pieces', align: 'right' as const, width: 90 }] : []),
                    { title: isJobwork ? 'Earned' : 'Billed', dataIndex: 'gross', align: 'right' as const, width: 140, render: (v: number) => money(v, symbol) },
                    { title: 'Paid', dataIndex: 'paid', align: 'right' as const, width: 140, render: (v: number) => <span style={{ color: '#237804' }}>{money(v, symbol)}</span> },
                    { title: 'Balance', dataIndex: 'balance', align: 'right' as const, width: 140, render: (v: number) => <b style={{ color: v > 0 ? '#cf1322' : '#999' }}>{money(v, symbol)}</b> },
                  ]}
                />
              ),
            },
            {
              key: 'payments',
              label: `Payments (${data.payments?.length ?? 0})`,
              children: (
                <Table
                  rowKey="id"
                  size="small"
                  pagination={false}
                  dataSource={data.payments ?? []}
                  columns={[
                    { title: 'Date', dataIndex: 'date', width: 110, render: (d) => dayjs(d).format('DD MMM YY') },
                    { title: 'Amount', dataIndex: 'amount', align: 'right', width: 140, render: (v) => <b>{money(v, symbol)}</b> },
                    { title: 'Ref', dataIndex: 'ref', width: 150, render: (v) => v || '—' },
                    { title: 'Applied to', key: 'alloc', render: (_, r: AllocatedPayment) => <AllocationTags p={r} symbol={symbol} /> },
                  ]}
                  locale={{ emptyText: 'Nothing paid yet.' }}
                />
              ),
            },
          ]}
        />
      </Card>

      <div className="print-area" style={{ display: 'none' }}>
        <div className="doc-sheet">
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#4e342e' }}>Saraswati Export</div>
              <div style={{ color: '#777', fontSize: 12 }}>Statement of account</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontWeight: 700 }}>{data.party.name}</div>
              <div style={{ color: '#777', fontSize: 12 }}>
                {meta.label} · as at {dayjs().format('DD MMM YYYY')}
              </div>
            </div>
          </div>
          <table className="doc-table">
            <thead>
              <tr>
                <th style={{ width: 80 }}>Date</th>
                <th>Detail</th>
                <th style={{ width: 90, textAlign: 'right' }}>Charge</th>
                <th style={{ width: 90, textAlign: 'right' }}>Settled</th>
                <th style={{ width: 100, textAlign: 'right' }}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {(data.statement ?? []).map((r, i) => (
                <tr key={i}>
                  <td>{dayjs(r.date).format('DD MMM YY')}</td>
                  <td>
                    {r.description}
                    {r.detail ? <div style={{ color: '#999', fontSize: 12 }}>{r.detail}</div> : null}
                  </td>
                  <td style={{ textAlign: 'right' }}>{r.charge ? num(r.charge, 2) : ''}</td>
                  <td style={{ textAlign: 'right' }}>{r.settle ? num(r.settle, 2) : ''}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{num(r.balance, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 12, textAlign: 'right', fontWeight: 700 }}>Closing balance: {money(s.balance, symbol)}</div>
        </div>
      </div>
    </div>
  );
}
