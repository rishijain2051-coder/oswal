import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Breadcrumb, Button, Card, DatePicker, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, Tooltip, Typography, message } from 'antd';
import { HomeOutlined, PlusOutlined, QuestionCircleOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { addFinishedTxn, FINISHED_KIND_TEXT, invalidateSales, removeFinishedTxn, STOCK_REASON_TEXT, useFinishedStock, useFinishedTxns, type FinishedStockRow } from '../../api/sales';
import { apiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';

const { Title, Text } = Typography;

/** What the operator is recording. PHYSICAL_COUNT is special — see the modal. */
const REASONS = [
  { value: 'OPENING', label: 'Opening balance' },
  { value: 'DAMAGE', label: 'Damaged / written off' },
  { value: 'PHYSICAL_COUNT', label: 'Physical count correction' },
  { value: 'RETURN', label: 'Returned by buyer' },
];

export default function FinishedStockPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canEdit = can('finished.adjust');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);

  const { data: rows = [], isLoading } = useFinishedStock(q || undefined);
  const { data: txns = [] } = useFinishedTxns();

  // Form state for the adjustment modal.
  const [productId, setProductId] = useState<number>();
  const [orderLineId, setOrderLineId] = useState<number | null>(null);
  const [reason, setReason] = useState('OPENING');
  const [qty, setQty] = useState<number | null>(null);
  const [date, setDate] = useState(dayjs());
  const [note, setNote] = useState('');

  const product = rows.find((r) => r.productId === productId);
  const cell = orderLineId != null ? product?.orders.find((o) => o.orderLineId === orderLineId) : product?.freePool;
  const onHand = cell?.onHand ?? 0;
  const shipped = orderLineId != null ? (product?.orders.find((o) => o.orderLineId === orderLineId)?.shipped ?? 0) : 0;

  const counting = reason === 'PHYSICAL_COUNT';
  /** On a count the operator types what they counted; the posted row is the difference. */
  const delta = counting ? (qty ?? 0) - onHand : (qty ?? 0);
  const kind: 'ADJUST_IN' | 'ADJUST_OUT' | 'RETURN_IN' = reason === 'RETURN' ? 'RETURN_IN' : delta < 0 ? 'ADJUST_OUT' : 'ADJUST_IN';

  /** Advisory only — the server refuses under a row lock. This just warns first. */
  const warning =
    delta < 0 && Math.abs(delta) > onHand
      ? `Only ${onHand} pc(s) are on hand${shipped > 0 ? `, and ${shipped} have already shipped` : ''}.`
      : counting && qty == null
        ? null
        : null;

  const reset = () => {
    setProductId(undefined);
    setOrderLineId(null);
    setReason('OPENING');
    setQty(null);
    setNote('');
    setDate(dayjs());
  };

  const save = useMutation({
    mutationFn: () =>
      addFinishedTxn({
        productId: productId!,
        kind,
        qty: Math.abs(delta),
        orderLineId,
        reason,
        note: note || undefined,
        date: date.toISOString(),
      }),
    onSuccess: () => {
      message.success('Recorded.');
      invalidateSales(qc);
      setOpen(false);
      reset();
    },
    onError: (e) => message.error(apiError(e)),
  });

  const remove = useMutation({
    mutationFn: removeFinishedTxn,
    onSuccess: () => {
      message.success('Removed.');
      invalidateSales(qc);
    },
    onError: (e) => message.error(apiError(e)),
  });

  return (
    <div>
      <Breadcrumb
        style={{ marginBottom: 12 }}
        items={[{ title: <Link to="/"><HomeOutlined /></Link> }, { title: <Link to="/sales">Dispatch</Link> }, { title: 'Finished Stock' }]}
      />
      <Space style={{ justifyContent: 'space-between', width: '100%', marginBottom: 12 }}>
        <Title level={4} style={{ margin: 0 }}>
          Finished Stock
        </Title>
        <Space>
          {/* A filter box needs an id/name for the browser to identify it, and
              autoComplete="off" because a search term is not data worth remembering. */}
          <Input.Search
            id="finished-stock-search"
            name="finished-stock-search"
            autoComplete="off"
            allowClear
            placeholder="Product code or name"
            style={{ width: 240 }}
            onSearch={setQ}
          />
          {canEdit && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
              Adjustment
            </Button>
          )}
        </Space>
      </Space>

      <Card size="small" styles={{ body: { paddingTop: 8 } }}>
        <Table
          size="small"
          rowKey="productId"
          loading={isLoading}
          dataSource={rows}
          pagination={{ pageSize: 25, hideOnSinglePage: true }}
          expandable={{
            rowExpandable: (r) => r.orders.length > 0 || !!r.freePool,
            expandedRowRender: (r: FinishedStockRow) => (
              <Table
                size="small"
                rowKey={(o) => String(o.orderLineId ?? 'free')}
                pagination={false}
                dataSource={[
                  ...r.orders,
                  ...(r.freePool && r.freePool.onHand !== 0
                    ? [{ orderLineId: null as never, orderId: null, orderNumber: null, orderStatus: '', buyerName: '', boardDone: 0, adjusted: r.freePool.onHand, returned: 0, packed: 0, shipped: 0, onHand: r.freePool.onHand, availableToPack: r.freePool.availableToPack, availableToShip: r.freePool.availableToShip, overProduced: 0 }]
                    : []),
                ]}
                columns={[
                  {
                    title: 'Order',
                    render: (_, o) =>
                      o.orderId ? (
                        <Link to={`/operations/orders/${o.orderId}`}>{o.orderNumber}</Link>
                      ) : (
                        <Tag color="blue">Free pool</Tag>
                      ),
                  },
                  { title: 'Buyer', dataIndex: 'buyerName' },
                  { title: 'On board', dataIndex: 'boardDone', align: 'right' as const },
                  { title: 'Adjusted', dataIndex: 'adjusted', align: 'right' as const },
                  { title: 'Returned', dataIndex: 'returned', align: 'right' as const },
                  { title: 'Packed', dataIndex: 'packed', align: 'right' as const },
                  { title: 'Shipped', dataIndex: 'shipped', align: 'right' as const },
                  { title: 'On hand', dataIndex: 'onHand', align: 'right' as const, render: (v: number) => <b>{v}</b> },
                  { title: 'To pack', dataIndex: 'availableToPack', align: 'right' as const },
                  { title: 'To ship', dataIndex: 'availableToShip', align: 'right' as const },
                  {
                    title: 'Over',
                    dataIndex: 'overProduced',
                    align: 'right' as const,
                    render: (v: number) => (v > 0 ? <Tag color="orange">{v}</Tag> : null),
                  },
                ]}
              />
            ),
          }}
          columns={[
            { title: 'Code', dataIndex: 'factoryCode', render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span> },
            { title: 'Product', dataIndex: 'name' },
            { title: 'Unit', dataIndex: 'unit', width: 60 },
            { title: 'Finished on board', dataIndex: 'boardDone', align: 'right' as const },
            { title: 'Adjusted', dataIndex: 'adjusted', align: 'right' as const },
            { title: 'Bought in', dataIndex: 'boughtIn', align: 'right' as const },
            { title: 'Returned', dataIndex: 'returned', align: 'right' as const },
            { title: 'Packed', dataIndex: 'packed', align: 'right' as const },
            { title: 'Shipped', dataIndex: 'shipped', align: 'right' as const },
            {
              title: (
                <Tooltip title="Worked out from the board and the adjustment ledger every time this page loads. There is nothing to type here.">
                  <span>
                    On hand <QuestionCircleOutlined style={{ color: '#999' }} />
                  </span>
                </Tooltip>
              ),
              dataIndex: 'onHand',
              align: 'right' as const,
              render: (v: number) => <b>{v}</b>,
            },
            { title: 'To pack', dataIndex: 'availableToPack', align: 'right' as const },
            { title: 'To ship', dataIndex: 'availableToShip', align: 'right' as const },
          ]}
        />
      </Card>

      {/* There is deliberately no location or godown column: one factory, one floor. */}

      <Card size="small" title="Recent adjustments" style={{ marginTop: 16 }}>
        <Table
          size="small"
          rowKey="id"
          dataSource={txns}
          pagination={{ pageSize: 12, hideOnSinglePage: true }}
          columns={[
            { title: 'Date', dataIndex: 'date', width: 110, render: (v: string) => dayjs(v).format('DD MMM YYYY') },
            { title: 'Product', render: (_, r) => `${r.productCode} — ${r.productName}` },
            {
              title: 'Order',
              render: (_, r) => (r.orderId ? <Link to={`/operations/orders/${r.orderId}`}>{r.orderNumber}</Link> : <Tag color="blue">Free pool</Tag>),
            },
            { title: 'What', dataIndex: 'kind', render: (v: string) => FINISHED_KIND_TEXT[v] ?? v },
            { title: 'Why', dataIndex: 'reason', render: (v: string | null) => (v ? <Tag>{STOCK_REASON_TEXT[v] ?? v}</Tag> : null) },
            {
              title: 'Qty',
              dataIndex: 'qty',
              align: 'right' as const,
              render: (v: number, r) => <span style={{ color: r.kind === 'ADJUST_OUT' ? '#c62828' : undefined }}>{r.kind === 'ADJUST_OUT' ? `-${v}` : `+${v}`}</span>,
            },
            { title: 'Note', dataIndex: 'note', ellipsis: true },
            ...(canEdit
              ? [
                  {
                    title: '',
                    width: 60,
                    render: (_: unknown, r: { id: number }) => (
                      // There is no edit, so a wrong entry has to be removable. The server
                      // refuses when removing it would drive stock below what has shipped.
                      <Popconfirm title="Remove this movement?" description="Stock will go back to what it was." onConfirm={() => remove.mutate(r.id)}>
                        <Button size="small" danger type="text">
                          Remove
                        </Button>
                      </Popconfirm>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Card>

      <Modal
        open={open}
        title="Finished stock adjustment"
        onCancel={() => {
          setOpen(false);
          reset();
        }}
        onOk={() => save.mutate()}
        okButtonProps={{ disabled: !productId || !qty || !!warning || delta === 0, loading: save.isPending }}
        okText="Record"
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <div>
            <Text type="secondary">Product</Text>
            <Select
              showSearch
              style={{ width: '100%' }}
              placeholder="Pick a product"
              value={productId}
              optionFilterProp="label"
              onChange={(v) => {
                setProductId(v);
                setOrderLineId(null);
              }}
              options={rows.map((r) => ({ value: r.productId, label: `${r.factoryCode} — ${r.name}` }))}
            />
          </div>
          <div>
            <Text type="secondary">Against an order (blank = free pool)</Text>
            <Select
              allowClear
              style={{ width: '100%' }}
              placeholder="Free pool"
              value={orderLineId ?? undefined}
              onChange={(v) => setOrderLineId(v ?? null)}
              options={(product?.orders ?? []).map((o) => ({ value: o.orderLineId, label: `${o.orderNumber} — ${o.buyerName} (${o.onHand} on hand)` }))}
            />
          </div>
          <div>
            <Text type="secondary">Why</Text>
            <Select style={{ width: '100%' }} value={reason} onChange={setReason} options={REASONS} />
          </div>
          <div>
            <Text type="secondary">{counting ? 'Counted quantity' : 'Quantity (negative to take out)'}</Text>
            <InputNumber style={{ width: '100%' }} value={qty} onChange={setQty} precision={0} />
            {counting && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                On hand is {onHand}. This will post {delta >= 0 ? `+${delta}` : delta}.
              </Text>
            )}
          </div>
          <div>
            <Text type="secondary">Date</Text>
            <DatePicker style={{ width: '100%' }} value={date} onChange={(d) => d && setDate(d)} format="DD MMM YYYY" />
          </div>
          <Input.TextArea rows={2} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          {warning && <Alert type="error" showIcon message={warning} />}
        </Space>
      </Modal>
    </div>
  );
}
