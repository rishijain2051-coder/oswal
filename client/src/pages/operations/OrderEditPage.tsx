import { useEffect, useState } from 'react';
import { Alert, App, Breadcrumb, Button, Card, Col, DatePicker, Divider, Input, InputNumber, Popconfirm, Row, Select, Space, Table, Tag, Typography } from 'antd';
import { HomeOutlined, PlusOutlined, DeleteOutlined, ThunderboltOutlined, SaveOutlined, LockOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import type { ColumnsType } from 'antd/es/table';
import { api, apiError } from '../../api/client';
import { useBuyers, useCompany, useCurrencies, useProducts } from '../../api/hooks';
import { useOrder, suggestPrice, type DocCharge } from '../../api/ops';
import { PriceHint } from '../../components/HistoryHint';
import { documentTotals, isDomestic, lineGross, lineNet } from '../../util/pricing';
import ChargesEditor from '../../components/ChargesEditor';
import DocumentTotalsPanel from '../../components/DocumentTotals';
import { money, num } from '../../util/format';

const { Title, Text } = Typography;

/** A line being edited. `committed` pieces are already in production or finished. */
interface LineDraft {
  id?: number;
  productId?: number;
  qty: number;
  unitPrice: number;
  committed: number;
  label?: string;
  moves: number;
  /** Carried from the quote; part of what the order is worth. */
  discountPct: number;
  discountAmt: number;
  /** Domestic only; ignored on an export, which is zero-rated. */
  gstRatePct: number;
  hsnCode?: string | null;
}

export default function OrderEditPage() {
  const { id } = useParams();
  const editing = !!id;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { message } = App.useApp();

  const { data: buyers } = useBuyers();
  const { data: currencies } = useCurrencies();
  const { data: products } = useProducts({});
  const { data: order } = useOrder(editing ? id : undefined);

  const [buyerId, setBuyerId] = useState<number>();
  const [currencyId, setCurrencyId] = useState<number>();
  const [orderDate, setOrderDate] = useState<dayjs.Dayjs>(dayjs());
  const [deliveryDate, setDeliveryDate] = useState<dayjs.Dayjs | null>(null);
  const [incoterms, setIncoterms] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [charges, setCharges] = useState<DocCharge[]>([]);
  const { data: company } = useCompany();

  useEffect(() => {
    if (editing && order) {
      setBuyerId(order.buyerId);
      setCurrencyId(order.currencyId ?? undefined);
      setOrderDate(dayjs(order.orderDate));
      setDeliveryDate(order.deliveryDate ? dayjs(order.deliveryDate) : null);
      setIncoterms(order.incoterms ?? '');
      setNotes(order.notes ?? '');
      setLines(
        order.lines.map((l) => ({
          id: l.id,
          productId: l.productId,
          qty: l.qty,
          unitPrice: l.unitPrice,
          committed: l.board.wip + l.board.done,
          label: `${l.product.factoryCode} — ${l.product.name}`,
          moves: l.history.length,
          discountPct: l.discountPct ?? 0,
          discountAmt: l.discountAmt ?? 0,
          gstRatePct: l.gstRatePct ?? 0,
          hsnCode: l.hsnCode ?? null,
        }))
      );
      setCharges(order.charges ?? []);
    } else if (!editing && currencies && currencyId === undefined) {
      const nonBase = currencies.find((c) => !c.isBase) ?? currencies[0];
      setCurrencyId(nonBase?.id);
    }
  }, [editing, order, currencies]); // eslint-disable-line react-hooks/exhaustive-deps

  const symbol = currencies?.find((c) => c.id === currencyId)?.symbol ?? '₹';
  const buyer = buyers?.find((b) => b.id === buyerId);
  const domestic = isDomestic(buyer?.market);

  // The same engine the server runs, so what is shown is what will be saved.
  const totals = documentTotals(
    lines.map((l) => ({ qty: l.qty || 0, unitPrice: l.unitPrice || 0, discountPct: l.discountPct, discountAmt: l.discountAmt, gstRatePct: l.gstRatePct })),
    // Only the charges that will actually be SAVED — a nameless row is filtered out on
    // save, so including it here made the preview total higher than the stored one.
    charges.filter((c) => c.name.trim()),
    { market: buyer?.market, buyerState: buyer?.state, companyState: company?.state }
  );
  const total = totals.grandTotal;
  const locked = lines.filter((l) => l.moves > 0);

  const setLine = (i: number, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, { qty: 1, unitPrice: 0, committed: 0, moves: 0, discountPct: 0, discountAmt: 0, gstRatePct: domestic ? 18 : 0, hsnCode: null }]);
  const suggest = async (i: number, productId: number) => {
    try {
      // Non-FOB in rupees for a domestic buyer, FOB converted for an export.
      const r = await suggestPrice(productId, currencyId, buyerId);
      setLine(i, { unitPrice: r.suggested, ...(domestic ? { gstRatePct: r.gstRatePct ?? 0, hsnCode: r.hsnCode ?? null } : {}) });
    } catch (e) {
      message.error(apiError(e));
    }
  };

  const save = useMutation({
    mutationFn: () => {
      const body = {
        buyerId,
        currencyId,
        orderDate: orderDate.toISOString(),
        deliveryDate: deliveryDate ? deliveryDate.toISOString() : null,
        incoterms: incoterms || null,
        notes: notes || null,
        lines: lines.filter((l) => l.productId).map((l) => ({
          ...(l.id ? { id: l.id } : {}),
          productId: l.productId,
          qty: l.qty,
          unitPrice: l.unitPrice,
          discountPct: l.discountPct ?? 0,
          discountAmt: l.discountAmt ?? 0,
          gstRatePct: domestic ? l.gstRatePct ?? 0 : 0,
          hsnCode: domestic ? l.hsnCode ?? null : null,
        })),
        charges: charges
          .filter((c) => c.name.trim())
          .map((c) => ({ name: c.name, kind: c.kind, amount: c.amount, pct: c.pct, gstRatePct: domestic && c.isTaxable ? c.gstRatePct : 0, isTaxable: c.isTaxable, note: c.note ?? null })),
      };
      return editing ? api.put(`/orders/${id}`, body) : api.post('/orders', body);
    },
    onSuccess: (res) => {
      message.success(editing ? 'Order saved.' : 'Order created — stages are ready on the board.');
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['order', id] });
      qc.invalidateQueries({ queryKey: ['ops-dashboard'] });
      navigate(`/operations/orders/${(res.data as any).id}`);
    },
    onError: (e) => message.error(apiError(e)),
  });

  const onSave = () => {
    if (!buyerId) return message.error('Select a buyer.');
    const usable = lines.filter((l) => l.productId);
    if (usable.length === 0) return message.error('Add at least one product line.');
    const short = usable.find((l) => l.qty < l.committed);
    if (short) return message.error(`${short.label}: ${short.committed} pc(s) are already in production — quantity cannot go below that.`);
    save.mutate();
  };

  const removeLine = (i: number) => setLines((ls) => ls.filter((_, j) => j !== i));

  const cols: ColumnsType<LineDraft> = [
    {
      title: 'Product',
      dataIndex: 'productId',
      render: (v, r, i) =>
        r.moves > 0 ? (
          <Space>
            <Text strong>{r.label}</Text>
            <Tag icon={<LockOutlined />}>in production</Tag>
          </Space>
        ) : (
          <Select
            showSearch
            optionFilterProp="label"
            style={{ width: 250 }}
            placeholder="Select product"
            value={v || undefined}
            options={(products ?? []).map((p) => ({ label: `${p.factoryCode} — ${p.name}`, value: p.id }))}
            onChange={(val) => {
              setLine(i, { productId: val, label: (products ?? []).find((p) => p.id === val)?.name });
              suggest(i, val);
            }}
          />
        ),
    },
    {
      title: 'Qty',
      dataIndex: 'qty',
      width: 130,
      render: (v, r, i) => (
        <div>
          <InputNumber min={Math.max(r.committed, 1)} value={v} onChange={(val) => setLine(i, { qty: val ?? 1 })} style={{ width: 90 }} />
          {r.committed > 0 && (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                min {r.committed}
              </Text>
            </div>
          )}
        </div>
      ),
    },
    {
      title: `Unit Price (${symbol})`,
      dataIndex: 'unitPrice',
      width: 175,
      render: (v, r, i) => (
        <Space.Compact>
          <InputNumber min={0} step={0.01} value={v} onChange={(val) => setLine(i, { unitPrice: val ?? 0 })} style={{ width: 115 }} />
          <Button icon={<ThunderboltOutlined />} title="Suggest from FOB" disabled={!r.productId} onClick={() => r.productId && suggest(i, r.productId)} />
          {/* What it actually sold for before, which the FOB figure cannot know. */}
          <PriceHint
            productId={r.productId}
            buyerId={buyerId}
            currency={currencies?.find((c) => c.id === currencyId)?.code}
            symbol={symbol}
            value={r.unitPrice}
            onApply={(val) => setLine(i, { unitPrice: val })}
          />
        </Space.Compact>
      ),
    },
    {
      title: 'Disc %',
      dataIndex: 'discountPct',
      width: 88,
      render: (v, _r, i) => <InputNumber min={0} max={100} value={v ?? 0} style={{ width: 78 }} onChange={(val) => setLine(i, { discountPct: val ?? 0 })} />,
    },
    {
      title: `Disc ${symbol}`,
      dataIndex: 'discountAmt',
      width: 96,
      render: (v, _r, i) => <InputNumber min={0} value={v ?? 0} style={{ width: 86 }} onChange={(val) => setLine(i, { discountAmt: val ?? 0 })} />,
    },
    ...(domestic
      ? ([
          {
            title: 'HSN',
            dataIndex: 'hsnCode',
            width: 88,
            render: (v: string | null, _r: LineDraft, i: number) => <Input value={v ?? ''} style={{ width: 78 }} placeholder="9403" onChange={(e) => setLine(i, { hsnCode: e.target.value })} />,
          },
        ] as ColumnsType<LineDraft>)
      : []),
    ...(domestic
      ? ([
          {
            title: 'GST %',
            dataIndex: 'gstRatePct',
            width: 88,
            render: (v: number, _r: LineDraft, i: number) => <InputNumber min={0} max={100} value={v ?? 0} style={{ width: 78 }} onChange={(val) => setLine(i, { gstRatePct: val ?? 0 })} />,
          },
        ] as ColumnsType<LineDraft>)
      : []),
    {
      title: 'Amount',
      key: 'amt',
      align: 'right',
      width: 130,
      // Net of this line's own discount, so it agrees with the subtotal below.
      render: (_, r) => {
        // The engine's own maths, never a copy of the rule.
        const gross = lineGross(r as never);
        const net = lineNet(r as never);
        return (
          <span>
            {net !== gross && (
              <Text type="secondary" delete style={{ fontSize: 12, display: 'block' }}>
                {money(gross, symbol)}
              </Text>
            )}
            <b>{money(net, symbol)}</b>
          </span>
        );
      },
    },
    {
      title: '',
      key: 'x',
      width: 46,
      render: (_, r, i) =>
        r.moves > 0 ? (
          <Button danger type="text" icon={<DeleteOutlined />} disabled title="Undo its movements first" />
        ) : (
          <Popconfirm title="Remove this line?" onConfirm={() => removeLine(i)} okButtonProps={{ danger: true }}>
            <Button danger type="text" icon={<DeleteOutlined />} />
          </Popconfirm>
        ),
    },
  ];

  return (
    <div>
      <Breadcrumb
        style={{ marginBottom: 16 }}
        items={[
          { title: <Link to="/"><HomeOutlined /></Link> },
          { title: <Link to="/operations">Operations</Link> },
          { title: <Link to="/operations/orders">Orders</Link> },
          { title: editing ? order?.number ?? 'Edit' : 'New Order' },
        ]}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>
          {editing ? `Edit Order ${order?.number ?? ''}` : 'New Order'}
        </Title>
        <Button type="primary" icon={<SaveOutlined />} loading={save.isPending} onClick={onSave}>
          Save
        </Button>
      </div>

      {locked.length > 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="Some lines are already in production"
          description="Their product cannot be swapped and their quantity cannot drop below the pieces already moving. Everything else is still editable."
        />
      )}

      <Card size="small" style={{ marginBottom: 16 }}>
        <Row gutter={[16, 12]}>
          <Col xs={24} md={8}>
            <Text type="secondary">Buyer *</Text>
            <Select showSearch optionFilterProp="label" style={{ width: '100%' }} value={buyerId} options={(buyers ?? []).map((b) => ({ label: `${b.code} · ${b.name}`, value: b.id }))} onChange={setBuyerId} />
          </Col>
          <Col xs={12} md={5}>
            <Text type="secondary">Currency</Text>
            <Select style={{ width: '100%' }} value={currencyId} options={(currencies ?? []).map((c) => ({ label: `${c.code} (${c.symbol})`, value: c.id }))} onChange={setCurrencyId} />
          </Col>
          <Col xs={12} md={5}>
            <Text type="secondary">Order date</Text>
            <DatePicker style={{ width: '100%' }} value={orderDate} onChange={(d) => setOrderDate(d ?? dayjs())} allowClear={false} />
          </Col>
          <Col xs={12} md={6}>
            <Text type="secondary">Delivery date</Text>
            <DatePicker style={{ width: '100%' }} value={deliveryDate} onChange={setDeliveryDate} />
          </Col>
          <Col xs={12} md={8}>
            <Text type="secondary">Incoterms</Text>
            <Input value={incoterms} onChange={(e) => setIncoterms(e.target.value)} placeholder="e.g. FOB Mundra" />
          </Col>
          <Col xs={24} md={16}>
            <Text type="secondary">Notes</Text>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Col>
        </Row>
      </Card>

      <Card size="small" title="Products" extra={<Button size="small" icon={<PlusOutlined />} onClick={addLine}>Add line</Button>}>
        <Table<LineDraft> rowKey={(_, i) => String(i)} size="small" columns={cols} dataSource={lines} pagination={false} scroll={{ x: 1000 }} />

        <Divider style={{ margin: '16px 0 12px' }} />
        <ChargesEditor charges={charges} subtotal={totals.subtotal} symbol={symbol} taxed={domestic} defaultGstPct={18} onChange={setCharges} />

        <Divider style={{ margin: '16px 0 12px' }} />
        <DocumentTotalsPanel totals={totals} symbol={symbol} />
        {domestic && lines.length > 0 && lines.every((l) => !(l.gstRatePct ?? 0)) && (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 12 }}
            message="No GST rate on any line"
            description={
              <Space direction="vertical" size={4}>
                <span>This is a domestic order, so it should carry GST — but every line is at 0%.</span>
                <Button size="small" onClick={() => setLines((ls) => ls.map((l) => ({ ...l, gstRatePct: 18, hsnCode: l.hsnCode || '9403' })))}>
                  Set every line to 18% (HSN 9403)
                </Button>
              </Space>
            }
          />
        )}
        {totals.mismatchedChargeRates.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 12 }}
            message={`A discount is taxed at ${totals.mismatchedChargeRates.map((r) => `${r}%`).join(', ')}, which none of the goods use`}
            description="That relieves more tax than the goods carry. Set the discount's rate to match the products it applies to."
          />
        )}
        {totals.overDiscounted && (
          <Alert type="error" showIcon style={{ marginTop: 12 }} message="The discounts are larger than the goods" description="The total has been held at zero. Check the discount amounts." />
        )}
        {currencyId && currencies?.find((c) => c.id === currencyId && !c.isBase) && (
          <div style={{ textAlign: 'right', marginTop: 4 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              ≈ ₹{num(total * (currencies.find((c) => c.id === currencyId)?.rateToBase ?? 1))}
            </Text>
          </div>
        )}
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 10 }}>
          New lines pick up their stage line from the product. Adjust who makes what on the order board afterwards.
        </Text>
      </Card>
    </div>
  );
}
