import { Button, Card, Col, Divider, Input, InputNumber, Row, Select, Space, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useAttributes, useBuyers, useMeta, useUnits } from '../../../api/hooks';
import { useStageLines } from '../../../api/ops';
import type { WizardDraft } from './draft';
import { CBM_PER_CUBIC_INCH, round4 } from '../../../util/shipping';

const { Text } = Typography;

// CBM per cubic inch and the 4-dp rounding come from the shipping engine, so the volume
// shown here and the carton volume the packing screen computes can never disagree. It is
// defined ONCE, in the mirrored pair — see client/src/util/shipping.ts.

// Hoisted (module-scope) so it is NOT recreated on every keystroke — that was
// causing inputs to remount and steal focus back to the first field.
function NumField({
  label,
  value,
  onChange,
  step,
  hint,
}: {
  label: string;
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  step?: number;
  hint?: string;
}) {
  return (
    <Col xs={12} md={6}>
      <div style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 2 }}>
        {label} {hint && <Tag color="blue" style={{ marginLeft: 2, fontSize: 10, lineHeight: '14px', padding: '0 4px' }}>{hint}</Tag>}
      </div>
      <InputNumber style={{ width: '100%' }} step={step ?? 1} value={value ?? undefined} onChange={onChange} />
    </Col>
  );
}

export default function StepDetails({
  draft,
  set,
  errors,
}: {
  draft: WizardDraft;
  set: (patch: Partial<WizardDraft>) => void;
  errors?: { factoryCode?: boolean; name?: boolean };
}) {
  const { data: meta } = useMeta();
  const { data: units } = useUnits();
  const { data: buyers } = useBuyers();
  const { data: itemTypes } = useAttributes('ITEM_TYPE');
  const { data: productTypes } = useAttributes('PRODUCT_TYPE');
  const { data: sizes } = useAttributes('SIZE');
  const { data: colours } = useAttributes('COLOUR');
  const { data: materials } = useAttributes('MATERIAL');
  const { data: finishes } = useAttributes('FINISH');
  const { data: stageLines } = useStageLines();

  const attrOpts = (arr?: { id: number; value: string }[]) => (arr ?? []).map((a) => ({ label: a.value, value: a.id }));

  // Update dimensions and auto-recompute the derived volume (editable afterwards).
  const setDim = (patch: Partial<WizardDraft>) => {
    const merged = { ...draft, ...patch } as WizardDraft;
    const out: Partial<WizardDraft> = { ...patch };
    if (['prodLengthIn', 'prodWidthIn', 'prodHeightIn'].some((k) => k in patch)) {
      const { prodLengthIn: l, prodWidthIn: w, prodHeightIn: h } = merged;
      if (l && w && h) out.volumeBeforePackingCbm = round4(l * w * h * CBM_PER_CUBIC_INCH);
    }
    if (['packLengthIn', 'packWidthIn', 'packHeightIn', 'piecesPerCarton'].some((k) => k in patch)) {
      const { packLengthIn: l, packWidthIn: w, packHeightIn: h, piecesPerCarton: pc } = merged;
      if (l && w && h) out.volumeAfterPackingCbm = round4((l * w * h * CBM_PER_CUBIC_INCH) / Math.max(pc || 1, 1));
    }
    set(out);
  };

  return (
    <div>
      <Card title="Main Details" size="small" style={{ marginBottom: 16 }}>
        <Row gutter={[16, 12]}>
          <Col xs={24} md={8}>
            <Text type="secondary">Factory Code *</Text>
            <Input
              status={errors?.factoryCode ? 'error' : undefined}
              value={draft.factoryCode}
              onChange={(e) => set({ factoryCode: e.target.value })}
              placeholder="e.g. AB-00123"
            />
            {errors?.factoryCode && <div style={{ color: '#ff4d4f', fontSize: 12 }}>Factory Code is required</div>}
          </Col>
          <Col xs={24} md={10}>
            <Text type="secondary">Item Description / Name *</Text>
            <Input
              status={errors?.name ? 'error' : undefined}
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="e.g. Crazy Almirah"
            />
            {errors?.name && <div style={{ color: '#ff4d4f', fontSize: 12 }}>Name is required</div>}
          </Col>
          <Col xs={24} md={6}>
            <Text type="secondary">Status</Text>
            <Select
              style={{ width: '100%' }}
              value={draft.status}
              options={(meta?.productStatuses ?? ['Draft', 'Active', 'Discontinued']).map((s) => ({ label: s, value: s }))}
              onChange={(v) => set({ status: v })}
            />
          </Col>
          <Col xs={24} md={12}>
            <Text type="secondary">Alias / Other Names</Text>
            <Input value={draft.alias ?? ''} onChange={(e) => set({ alias: e.target.value })} />
          </Col>
          <Col xs={12} md={6}>
            <Text type="secondary">Item Type</Text>
            <Select allowClear style={{ width: '100%' }} value={draft.itemTypeId ?? undefined} options={attrOpts(itemTypes)} onChange={(v) => set({ itemTypeId: v ?? null })} />
          </Col>
          <Col xs={12} md={6}>
            <Text type="secondary">Unit of Measure</Text>
            <Select allowClear style={{ width: '100%' }} value={draft.unitId ?? undefined} options={(units ?? []).map((u) => ({ label: `${u.code} — ${u.name}`, value: u.id }))} onChange={(v) => set({ unitId: v ?? null })} />
          </Col>
        </Row>
      </Card>

      <Card title="Classification" size="small" style={{ marginBottom: 16 }}>
        <Row gutter={[16, 12]}>
          <Col xs={12} md={8}>
            <Text type="secondary">Product Type</Text>
            <Select allowClear style={{ width: '100%' }} value={draft.productTypeId ?? undefined} options={attrOpts(productTypes)} onChange={(v) => set({ productTypeId: v ?? null })} />
          </Col>
          <Col xs={12} md={8}>
            <Text type="secondary">Size</Text>
            <Select allowClear style={{ width: '100%' }} value={draft.sizeId ?? undefined} options={attrOpts(sizes)} onChange={(v) => set({ sizeId: v ?? null })} />
          </Col>
          <Col xs={12} md={8}>
            <Text type="secondary">Colour</Text>
            <Select allowClear style={{ width: '100%' }} value={draft.colourId ?? undefined} options={attrOpts(colours)} onChange={(v) => set({ colourId: v ?? null })} />
          </Col>
          <Col xs={12} md={8}>
            <Text type="secondary">Material</Text>
            <Select allowClear style={{ width: '100%' }} value={draft.materialId ?? undefined} options={attrOpts(materials)} onChange={(v) => set({ materialId: v ?? null })} />
          </Col>
          <Col xs={12} md={8}>
            <Text type="secondary">Finish</Text>
            <Select allowClear style={{ width: '100%' }} value={draft.finishId ?? undefined} options={attrOpts(finishes)} onChange={(v) => set({ finishId: v ?? null })} />
          </Col>
          <Col xs={24} md={16}>
            <Text type="secondary">Production stage line</Text>
            <Select
              allowClear
              style={{ width: '100%' }}
              placeholder={stageLines?.some((l) => l.isDefault) ? 'Uses the default line if left blank' : 'Select the route this product travels'}
              value={draft.stageLineId ?? undefined}
              options={(stageLines ?? [])
                .filter((l) => l.isActive || l.id === draft.stageLineId)
                .map((l) => ({ label: `${l.code} — ${l.name}  (${l.steps.map((s) => s.name).join(' → ')})`, value: l.id }))}
              onChange={(v) => {
                // Labour lines map onto the steps of THIS line, so a different route
                // makes those mappings meaningless — drop them rather than let the
                // save fail on a stage that belongs to another line.
                const mapped = draft.costSheet.groups.some((g) => g.head === 'LABOUR' && g.lines.some((l) => l.stageStepId != null));
                set({
                  stageLineId: v ?? null,
                  ...(mapped
                    ? { costSheet: { ...draft.costSheet, groups: draft.costSheet.groups.map((g) => (g.head === 'LABOUR' ? { ...g, lines: g.lines.map((l) => ({ ...l, stageStepId: null })) } : g)) } }
                    : {}),
                });
              }}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              The stages every order of this product moves through. Manage the lines in Master Data → Stage Lines. Changing it clears any labour lines mapped to the old stages.
            </Text>
          </Col>
        </Row>
        <Divider style={{ margin: '12px 0 8px' }} />
        <Text type="secondary">Description</Text>
        <Input.TextArea rows={2} value={draft.description ?? ''} onChange={(e) => set({ description: e.target.value })} />
      </Card>

      <Card
        title="Buyers"
        size="small"
        style={{ marginBottom: 16 }}
        extra={
          <Button size="small" icon={<PlusOutlined />} onClick={() => set({ buyers: [...draft.buyers, { buyerId: undefined as unknown as number, buyerCode: '' }] })}>
            Add buyer
          </Button>
        }
      >
        {draft.buyers.length === 0 && <Text type="secondary">No buyers linked. A product can have several buyers, each with their own article code.</Text>}
        <Space direction="vertical" style={{ width: '100%' }}>
          {draft.buyers.map((b, i) => (
            <Row gutter={8} key={i} align="middle">
              <Col xs={12} md={10}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder="Select buyer"
                  style={{ width: '100%' }}
                  value={b.buyerId ?? undefined}
                  options={(buyers ?? []).map((x) => ({ label: `${x.code} · ${x.name}`, value: x.id }))}
                  onChange={(v) => {
                    const arr = [...draft.buyers];
                    arr[i] = { ...arr[i], buyerId: v };
                    set({ buyers: arr });
                  }}
                />
              </Col>
              <Col xs={10} md={10}>
                <Input
                  placeholder="Buyer's article / style code"
                  value={b.buyerCode ?? ''}
                  onChange={(e) => {
                    const arr = [...draft.buyers];
                    arr[i] = { ...arr[i], buyerCode: e.target.value };
                    set({ buyers: arr });
                  }}
                />
              </Col>
              <Col xs={2}>
                <Button danger icon={<DeleteOutlined />} onClick={() => set({ buyers: draft.buyers.filter((_, j) => j !== i) })} />
              </Col>
            </Row>
          ))}
        </Space>
      </Card>

      <Card title="Physical, Packing & Differentiated Volumes" size="small">
        <Row gutter={[16, 12]}>
          <NumField label="Assembled L (in)" value={draft.prodLengthIn} step={0.1} onChange={(v) => setDim({ prodLengthIn: v })} />
          <NumField label="Assembled W (in)" value={draft.prodWidthIn} step={0.1} onChange={(v) => setDim({ prodWidthIn: v })} />
          <NumField label="Assembled H (in)" value={draft.prodHeightIn} step={0.1} onChange={(v) => setDim({ prodHeightIn: v })} />
          <NumField label="Net Weight (kg)" value={draft.netWeightKg} step={0.1} onChange={(v) => set({ netWeightKg: v })} />
          <NumField label="Packed L (in)" value={draft.packLengthIn} step={0.1} onChange={(v) => setDim({ packLengthIn: v })} />
          <NumField label="Packed W (in)" value={draft.packWidthIn} step={0.1} onChange={(v) => setDim({ packWidthIn: v })} />
          <NumField label="Packed H (in)" value={draft.packHeightIn} step={0.1} onChange={(v) => setDim({ packHeightIn: v })} />
          <NumField label="Gross Weight (kg)" value={draft.grossWeightKg} step={0.1} onChange={(v) => set({ grossWeightKg: v })} />
          <NumField label="Pcs / Carton" value={draft.piecesPerCarton} onChange={(v) => setDim({ piecesPerCarton: v })} />
          <NumField label="Vol. before packing (CBM)" hint="auto" value={draft.volumeBeforePackingCbm} step={0.001} onChange={(v) => set({ volumeBeforePackingCbm: v })} />
          <NumField label="Vol. after packing (CBM)" hint="auto" value={draft.volumeAfterPackingCbm} step={0.001} onChange={(v) => set({ volumeAfterPackingCbm: v })} />
        </Row>
        <Text type="secondary" style={{ fontSize: 12 }}>
          Volumes auto-calculate from the dimensions above (CBM = L×W×H inches × {CBM_PER_CUBIC_INCH}; “after packing” is divided by pcs/carton). You can still type your own value.
        </Text>
      </Card>

      {/*
        Tax classification. Reference only for costing — it seeds the rate and HSN on a
        DOMESTIC proforma or order line. An export is zero-rated, so neither field has
        any effect there, and neither touches the FOB roll-up.
      */}
      <Card title="Tax (domestic sales)" size="small" style={{ marginTop: 16 }}>
        <Row gutter={[16, 12]}>
          <Col xs={12} md={6}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              HSN code
            </Text>
            <Input value={draft.hsnCode ?? ''} placeholder="9403" onChange={(e) => set({ hsnCode: e.target.value })} />
          </Col>
          <NumField label="GST rate (%)" value={draft.gstRatePct ?? 18} step={0.5} onChange={(v) => set({ gstRatePct: v })} />
        </Row>
        <Text type="secondary" style={{ fontSize: 12 }}>
          Seeds the rate and HSN when this product goes on a domestic quote or order, where either can still be overridden on the line. Exports are zero-rated, so this never affects an
          overseas document — and it never affects the costing roll-up.
        </Text>
      </Card>
    </div>
  );
}
