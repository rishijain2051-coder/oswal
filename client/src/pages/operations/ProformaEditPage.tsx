import { useEffect, useState } from 'react';
import { App, Breadcrumb, Button, Card, Col, DatePicker, Empty, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Switch, Table, Tooltip, Typography } from 'antd';
import { HomeOutlined, PlusOutlined, DeleteOutlined, ThunderboltOutlined, SaveOutlined, PictureOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import type { ColumnsType } from 'antd/es/table';
import { api, apiError } from '../../api/client';
import { useBuyers, useCurrencies, useProduct, useProducts } from '../../api/hooks';
import { useProforma, suggestPrice, type DocCharge, type ProformaLineDto } from '../../api/ops';
import { PriceHint } from '../../components/HistoryHint';
import { money } from '../../util/format';
import { documentTotals, isDomestic, lineGross, lineNet } from '../../util/pricing';
import ChargesEditor from '../../components/ChargesEditor';
import DocumentTotalsPanel from '../../components/DocumentTotals';
import { useCompany } from '../../api/hooks';
import { Alert, Divider, Tag } from 'antd';

const { Title, Text } = Typography;

interface LineDraft extends ProformaLineDto {
  key: string;
}

/**
 * Picks which product photo prints on the PI. Loads the product's gallery only when
 * the user actually opens the picker, so a long line list stays cheap.
 */
function ImagePicker({ productId, imageId, onPick }: { productId?: number | null; imageId?: number | null; onPick: (id: number | null) => void }) {
  const [open, setOpen] = useState(false);
  const { data: product, isLoading } = useProduct(open && productId ? productId : undefined);
  const images = product?.images ?? [];
  const chosen = images.find((im) => im.id === imageId) ?? images.find((im) => im.isPrimary) ?? null;

  if (!productId)
    return (
      <Tooltip title="Link a product to show its photo">
        <Button size="small" type="text" disabled icon={<PictureOutlined />} />
      </Tooltip>
    );

  return (
    <>
      <Tooltip title="Choose the photo for this line">
        <Button size="small" type="text" onClick={() => setOpen(true)} style={{ padding: 0, height: 'auto' }}>
          {chosen ? <img src={chosen.url} alt="" style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 4, border: '1px solid #eee', display: 'block' }} /> : <PictureOutlined />}
        </Button>
      </Tooltip>
      <Modal open={open} onCancel={() => setOpen(false)} footer={null} title="Photo for this line" width={620}>
        {isLoading ? (
          <Empty description="Loading…" image={null} />
        ) : images.length === 0 ? (
          <Empty description="This product has no photos yet. Add them on the product page." />
        ) : (
          <Space wrap size={10}>
            {images.map((im) => {
              const active = (imageId ?? images.find((x) => x.isPrimary)?.id) === im.id;
              return (
                <div
                  key={im.id}
                  onClick={() => {
                    onPick(im.id);
                    setOpen(false);
                  }}
                  style={{
                    cursor: 'pointer',
                    border: active ? '2px solid #6d4c41' : '2px solid transparent',
                    borderRadius: 6,
                    padding: 2,
                  }}
                >
                  <img src={im.url} alt="" style={{ width: 108, height: 108, objectFit: 'cover', borderRadius: 4, display: 'block' }} />
                  <div style={{ textAlign: 'center', fontSize: 12, color: '#888' }}>{im.isPrimary ? 'primary' : im.caption || ''}</div>
                </div>
              );
            })}
          </Space>
        )}
        <div style={{ marginTop: 12, textAlign: 'right' }}>
          <Button
            size="small"
            onClick={() => {
              onPick(null);
              setOpen(false);
            }}
          >
            Use the product's primary photo
          </Button>
        </div>
      </Modal>
    </>
  );
}

let keySeq = 0;
const newKey = () => `l${++keySeq}`;

export default function ProformaEditPage() {
  const { id } = useParams();
  const editing = !!id;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { message } = App.useApp();

  const { data: buyers } = useBuyers();
  const { data: currencies } = useCurrencies();
  const { data: products } = useProducts({});
  const { data: pf } = useProforma(editing ? id : undefined);

  const [f, setF] = useState<any>({
    date: dayjs(),
    showImages: true,
    bankDetails: 'Bank: State Bank of India\nA/C: 000000000000\nIFSC: SBIN0000000\nSWIFT: SBININBB000',
  });
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [charges, setCharges] = useState<DocCharge[]>([]);

  useEffect(() => {
    if (editing && pf) {
      setF({
        buyerId: pf.buyerId,
        currencyId: pf.currencyId ?? undefined,
        date: dayjs(pf.date),
        validUntil: pf.validUntil ? dayjs(pf.validUntil) : null,
        paymentTerms: pf.paymentTerms ?? '',
        deliveryTerms: pf.deliveryTerms ?? '',
        incoterms: pf.incoterms ?? '',
        bankDetails: pf.bankDetails ?? '',
        notes: pf.notes ?? '',
        showImages: pf.showImages,
      });
      setLines(
        pf.lines.map((l) => ({
          key: newKey(),
          productId: l.productId ?? null,
          imageId: l.imageId ?? null,
          description: l.description,
          qty: l.qty,
          unitPrice: l.unitPrice,
          discountPct: l.discountPct ?? 0,
          discountAmt: l.discountAmt ?? 0,
          gstRatePct: l.gstRatePct ?? 0,
          hsnCode: l.hsnCode ?? null,
        }))
      );
      setCharges(pf.charges ?? []);
    } else if (!editing && currencies && f.currencyId === undefined) {
      const nonBase = currencies.find((c) => !c.isBase) ?? currencies[0];
      setF((s: any) => ({ ...s, currencyId: nonBase?.id }));
    }
  }, [editing, pf, currencies]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: any) => setF((s: any) => ({ ...s, ...patch }));
  const symbol = currencies?.find((c) => c.id === f.currencyId)?.symbol ?? '₹';

  // The buyer decides everything about how this document is priced: which basis the
  // suggestion uses, whether GST applies, and which series it will be numbered in.
  const buyer = buyers?.find((b) => b.id === f.buyerId);
  const domestic = isDomestic(buyer?.market);
  const { data: company } = useCompany();

  // The same engine the server runs, so the figures below match what will be saved.
  const totals = documentTotals(
    lines.map((l) => ({ qty: l.qty || 0, unitPrice: l.unitPrice || 0, discountPct: l.discountPct, discountAmt: l.discountAmt, gstRatePct: l.gstRatePct })),
    // Only the charges that will actually be SAVED — a nameless row is filtered out on
    // save, so including it here made the preview total higher than the stored one.
    charges.filter((c) => c.name.trim()),
    { market: buyer?.market, buyerState: buyer?.state, companyState: company?.state }
  );

  const setLine = (key: string, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, { key: newKey(), productId: null, imageId: null, description: '', qty: 1, unitPrice: 0, discountPct: 0, discountAmt: 0, gstRatePct: domestic ? 18 : 0, hsnCode: null }]);

  const pickProduct = async (key: string, productId: number) => {
    const p = products?.find((x) => x.id === productId);
    setLine(key, { productId, imageId: null, description: p?.name ?? '' });
    try {
      // The buyer's market decides the basis: Non-FOB in rupees for a domestic sale,
      // FOB converted for an export. The response also carries the tax classification.
      const r = await suggestPrice(productId, f.currencyId, f.buyerId);
      setLine(key, { unitPrice: r.suggested, ...(domestic ? { gstRatePct: r.gstRatePct ?? 0, hsnCode: r.hsnCode ?? null } : {}) });
    } catch (e) {
      message.error(apiError(e));
    }
  };

  const save = useMutation({
    mutationFn: () => {
      const body = {
        buyerId: f.buyerId,
        currencyId: f.currencyId,
        date: f.date?.toISOString(),
        validUntil: f.validUntil ? f.validUntil.toISOString() : null,
        paymentTerms: f.paymentTerms || null,
        deliveryTerms: f.deliveryTerms || null,
        incoterms: f.incoterms || null,
        bankDetails: f.bankDetails || null,
        notes: f.notes || null,
        showImages: !!f.showImages,
        lines: lines
          .filter((l) => l.description.trim())
          .map((l) => ({
            productId: l.productId ?? null,
            imageId: l.imageId ?? null,
            description: l.description,
            qty: l.qty,
            unitPrice: l.unitPrice,
            discountPct: l.discountPct ?? 0,
            discountAmt: l.discountAmt ?? 0,
            // Rates are only meaningful on a domestic document; an export is zero-rated
            // and the server ignores them anyway.
            gstRatePct: domestic ? l.gstRatePct ?? 0 : 0,
            hsnCode: domestic ? l.hsnCode ?? null : null,
          })),
        charges: charges
          .filter((c) => c.name.trim())
          .map((c) => ({ name: c.name, kind: c.kind, amount: c.amount, pct: c.pct, gstRatePct: domestic && c.isTaxable ? c.gstRatePct : 0, isTaxable: c.isTaxable, note: c.note ?? null })),
      };
      return editing ? api.put(`/proformas/${id}`, body) : api.post('/proformas', body);
    },
    onSuccess: (res) => {
      message.success('Saved.');
      qc.invalidateQueries({ queryKey: ['proformas'] });
      qc.invalidateQueries({ queryKey: ['proforma', id] });
      qc.invalidateQueries({ queryKey: ['ops-dashboard'] });
      navigate(`/operations/proformas/${(res.data as any).id}`);
    },
    onError: (e) => message.error(apiError(e)),
  });

  const onSave = () => {
    if (!f.buyerId) return message.error('Select a buyer.');
    if (lines.filter((l) => l.description.trim()).length === 0) return message.error('Add at least one line.');
    save.mutate();
  };

  const cols: ColumnsType<LineDraft> = [
    {
      title: 'Product',
      dataIndex: 'productId',
      width: 210,
      render: (v, r) => (
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: 200 }}
          placeholder="(optional)"
          value={v || undefined}
          options={(products ?? []).map((p) => ({ label: `${p.factoryCode} — ${p.name}`, value: p.id }))}
          onChange={(val) => (val ? pickProduct(r.key, val) : setLine(r.key, { productId: null, imageId: null }))}
        />
      ),
    },
    {
      title: 'Photo',
      key: 'img',
      width: 62,
      align: 'center',
      render: (_, r) => <ImagePicker productId={r.productId} imageId={r.imageId} onPick={(imageId) => setLine(r.key, { imageId })} />,
    },
    { title: 'Description', dataIndex: 'description', render: (v, r) => <Input value={v} onChange={(e) => setLine(r.key, { description: e.target.value })} /> },
    { title: 'Qty', dataIndex: 'qty', width: 80, render: (v, r) => <InputNumber min={1} value={v} onChange={(val) => setLine(r.key, { qty: val ?? 1 })} style={{ width: 70 }} /> },
    {
      title: `Unit Price (${symbol})`,
      dataIndex: 'unitPrice',
      width: 165,
      render: (v, r) => (
        <Space.Compact>
          <InputNumber min={0} step={0.01} value={v} style={{ width: 105 }} onChange={(val) => setLine(r.key, { unitPrice: val ?? 0 })} />
          <Button icon={<ThunderboltOutlined />} disabled={!r.productId} title="Suggest from FOB" onClick={() => r.productId && pickProduct(r.key, r.productId)} />
          {/* What this buyer, then anyone, has actually paid for it before. */}
          <PriceHint
            productId={r.productId}
            buyerId={f.buyerId}
            currency={currencies?.find((c) => c.id === f.currencyId)?.code}
            symbol={symbol}
            value={r.unitPrice}
            onApply={(val) => setLine(r.key, { unitPrice: val })}
          />
        </Space.Compact>
      ),
    },
    {
      title: 'Disc %',
      dataIndex: 'discountPct',
      width: 92,
      render: (v, r) => <InputNumber min={0} max={100} value={v ?? 0} style={{ width: 82 }} onChange={(val) => setLine(r.key, { discountPct: val ?? 0 })} />,
    },
    {
      title: `Disc ${symbol}`,
      dataIndex: 'discountAmt',
      width: 100,
      render: (v, r) => <InputNumber min={0} value={v ?? 0} style={{ width: 90 }} onChange={(val) => setLine(r.key, { discountAmt: val ?? 0 })} />,
    },
    ...(domestic
      ? ([
          {
            title: 'HSN',
            dataIndex: 'hsnCode',
            width: 90,
            render: (v: string | null, r: LineDraft) => <Input value={v ?? ''} style={{ width: 80 }} placeholder="9403" onChange={(e) => setLine(r.key, { hsnCode: e.target.value })} />,
          },
          {
            title: 'GST %',
            dataIndex: 'gstRatePct',
            width: 90,
            render: (v: number, r: LineDraft) => <InputNumber min={0} max={100} value={v ?? 0} style={{ width: 80 }} onChange={(val) => setLine(r.key, { gstRatePct: val ?? 0 })} />,
          },
        ] as ColumnsType<LineDraft>)
      : []),
    {
      title: 'Amount',
      key: 'amt',
      align: 'right',
      width: 120,
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
      width: 44,
      render: (_, r) => (
        <Popconfirm title="Remove this line?" onConfirm={() => setLines((ls) => ls.filter((l) => l.key !== r.key))} okButtonProps={{ danger: true }}>
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
          { title: <Link to="/operations/proformas">Proformas</Link> },
          { title: editing ? pf?.number ?? 'Edit' : 'New Proforma' },
        ]}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>
          {editing ? `Edit ${pf?.number ?? ''}` : 'New Proforma'}
        </Title>
        <Button type="primary" icon={<SaveOutlined />} loading={save.isPending} onClick={onSave}>
          Save
        </Button>
      </div>

      <Card size="small" style={{ marginBottom: 16 }}>
        <Row gutter={[16, 12]}>
          <Col xs={24} md={8}>
            <Text type="secondary">Buyer *</Text>
            <Select
              showSearch
              optionFilterProp="label"
              style={{ width: '100%' }}
              value={f.buyerId}
              options={(buyers ?? []).map((b) => ({ label: `${b.code} · ${b.name}${b.email ? '' : '  (no e-mail)'}`, value: b.id }))}
              onChange={(v) => {
                /**
                 * Picking the buyer brings their currency and terms with them.
                 *
                 * The form used to open on whichever currency came back first and leave it
                 * there, so a UK account could be quoted in euros by simply not noticing —
                 * and the order that followed would snapshot the wrong exchange rate too.
                 *
                 * Only fields the buyer actually has set are applied, and only on a NEW
                 * proforma: reassigning the buyer on an existing one must not silently
                 * re-price a document somebody has already been sent.
                 */
                const b = (buyers ?? []).find((x) => x.id === v);
                const defaults: Record<string, unknown> = { buyerId: v };
                if (!id && b) {
                  if (b.currencyId) defaults.currencyId = b.currencyId;
                  if (b.paymentTerms) defaults.paymentTerms = b.paymentTerms;
                  if (b.deliveryTerms) defaults.deliveryTerms = b.deliveryTerms;
                  // Incoterms are an export concept; a domestic quotation hides the field.
                  if (b.incoterms && b.market !== 'DOMESTIC') defaults.incoterms = b.incoterms;
                }
                set(defaults);
              }}
            />
            {buyer && (
              <div style={{ marginTop: 4 }}>
                <Tag color={domestic ? 'geekblue' : 'gold'}>{domestic ? 'Domestic' : 'Overseas'}</Tag>
                <Tag>{buyer.channel === 'B2C' ? 'B2C' : 'B2B'}</Tag>
                {domestic && <Text type="secondary" style={{ fontSize: 12 }}>{buyer.state ?? 'no state'}{buyer.gstNo ? ` · ${buyer.gstNo}` : ' · no GSTIN'}</Text>}
              </div>
            )}
          </Col>
          <Col xs={12} md={4}>
            <Text type="secondary">Currency</Text>
            <Select style={{ width: '100%' }} value={f.currencyId} options={(currencies ?? []).map((c) => ({ label: c.code, value: c.id }))} onChange={(v) => set({ currencyId: v })} />
          </Col>
          <Col xs={12} md={6}>
            <Text type="secondary">Date</Text>
            <DatePicker style={{ width: '100%' }} value={f.date} onChange={(d) => set({ date: d })} allowClear={false} />
          </Col>
          <Col xs={12} md={6}>
            <Text type="secondary">Valid until</Text>
            <DatePicker style={{ width: '100%' }} value={f.validUntil} onChange={(d) => set({ validUntil: d })} />
          </Col>
          <Col xs={12} md={8}>
            <Text type="secondary">Payment terms</Text>
            <Input value={f.paymentTerms} onChange={(e) => set({ paymentTerms: e.target.value })} placeholder="30% advance, balance vs BL" />
          </Col>
          <Col xs={12} md={8}>
            <Text type="secondary">Delivery terms</Text>
            <Input value={f.deliveryTerms} onChange={(e) => set({ deliveryTerms: e.target.value })} placeholder="Within 60 days" />
          </Col>
          {!domestic && (
            <Col xs={12} md={5}>
              <Text type="secondary">Incoterms</Text>
              <Input value={f.incoterms} onChange={(e) => set({ incoterms: e.target.value })} placeholder="FOB Mundra" />
            </Col>
          )}
          <Col xs={12} md={3}>
            <Text type="secondary" style={{ display: 'block' }}>
              Show photos
            </Text>
            <Switch checked={!!f.showImages} onChange={(v) => set({ showImages: v })} />
          </Col>
          <Col xs={24} md={12}>
            <Text type="secondary">Bank details</Text>
            <Input.TextArea rows={3} value={f.bankDetails} onChange={(e) => set({ bankDetails: e.target.value })} />
          </Col>
          <Col xs={24} md={12}>
            <Text type="secondary">Notes</Text>
            <Input.TextArea rows={3} value={f.notes} onChange={(e) => set({ notes: e.target.value })} />
          </Col>
        </Row>
      </Card>

      <Card size="small" title="Lines" extra={<Button size="small" icon={<PlusOutlined />} onClick={addLine}>Add line</Button>}>
        <Table<LineDraft> rowKey="key" size="small" columns={cols} dataSource={lines} pagination={false} scroll={{ x: 1100 }} locale={{ emptyText: 'No lines yet — add one.' }} />

        <Divider style={{ margin: '16px 0 12px' }} />
        <ChargesEditor charges={charges} subtotal={totals.subtotal} symbol={symbol} taxed={domestic} defaultGstPct={18} onChange={setCharges} />

        <Divider style={{ margin: '16px 0 12px' }} />
        <DocumentTotalsPanel totals={totals} symbol={symbol} />

        {/*
          A domestic document whose lines all sit at 0% shows a CGST+SGST tag above a
          total with no tax in it. That happens whenever the buyer is switched to
          domestic after the lines were added, so offer the fix rather than just warning.
        */}
        {domestic && lines.length > 0 && lines.every((l) => !(l.gstRatePct ?? 0)) && (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 12 }}
            message="No GST rate on any line"
            description={
              <Space direction="vertical" size={4}>
                <span>This is a domestic sale, so it should carry GST — but every line is at 0%, so no tax is being charged.</span>
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
            description="That relieves more tax than the goods carry and prints a negative GST line. Set the discount's rate to match the products it applies to."
          />
        )}
        {totals.overDiscounted && (
          <Alert type="error" showIcon style={{ marginTop: 12 }} message="The discounts are larger than the goods" description="The total has been held at zero. Check the discount amounts." />
        )}
        {domestic && !company?.state && (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 12 }}
            message="Your company has no state set"
            description="Without it, this sale is treated as inter-state and charged IGST. Set it in Master Data → Company."
          />
        )}
        {domestic && buyer && !buyer.gstNo && buyer.channel === 'B2B' && (
          <Alert type="info" showIcon style={{ marginTop: 12 }} message={`${buyer.name} has no GSTIN on file`} description="A trade buyer normally needs one on the document. Add it in Master Data → Buyers." />
        )}
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 10 }}>
          Photos print on the PI and on the PDF that goes out by e-mail. Each line uses the product's primary photo unless you pick another.
        </Text>
      </Card>
    </div>
  );
}
