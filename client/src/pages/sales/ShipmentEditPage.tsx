import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Breadcrumb, Button, Card, Col, DatePicker, Input, InputNumber, Progress, Result, Row, Select, Space, Table, Tag, Typography } from 'antd';
import { DeleteOutlined, HomeOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import {
  createShipment,
  invalidateSales,
  planShipment,
  updateShipment,
  useContainerTypes,
  useShipment,
  useShipmentCandidates,
  type PackingBatch,
  type ShipmentContainerInput,
  type ShipmentLineInput,
} from '../../api/sales';
import { useBuyers } from '../../api/hooks';
import { apiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { containerFit, guardCartonFit, guardShipQty, INCOTERMS, packedTotals, round4 } from '../../util/shipping';

const { Title, Text } = Typography;

interface LineDraft extends ShipmentLineInput {
  key: string;
  batch: PackingBatch;
}

interface ContainerDraft extends ShipmentContainerInput {
  key: string;
}

export default function ShipmentEditPage() {
  const { id } = useParams();
  const isNew = id === 'new' || id == null;
  const nav = useNavigate();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { can } = useAuth();

  const { data: existing } = useShipment(isNew ? undefined : id);
  const { data: buyers = [] } = useBuyers();
  const { data: types = [] } = useContainerTypes(true);

  /**
   * `?buyerId=` lets the order page start a dispatch for the buyer whose cartons are ready,
   * so "ship this order" lands on a picker already showing them. It seeds the state and is
   * not read again — the user may still change the buyer.
   */
  const [search] = useSearchParams();
  const seedBuyer = Number(search.get('buyerId')) || undefined;
  const [buyerId, setBuyerId] = useState<number | undefined>(isNew ? seedBuyer : undefined);
  const [shipDate, setShipDate] = useState<Dayjs | null>(dayjs());
  const [header, setHeader] = useState<Record<string, string | null>>({});
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [containers, setContainers] = useState<ContainerDraft[]>([]);

  // Discount this shipment's own cartons, or the batches it carries look already gone.
  const { data: candidates = [] } = useShipmentCandidates(buyerId, isNew ? undefined : Number(id));

  // Load an existing shipment's header and containers into the draft. Its LINES need the
  // candidate batches to hang off, so they are loaded in the effect below once those arrive.
  useEffect(() => {
    if (!existing) return;
    setShipDate(existing.shipDate ? dayjs(existing.shipDate) : null);
    setBuyerId(existing.orders[0]?.buyerId);
    setHeader({
      shippingBillNo: existing.shippingBillNo,
      portOfLoading: existing.portOfLoading,
      portOfDischarge: existing.portOfDischarge,
      finalDestination: existing.finalDestination,
      vesselOrFlight: existing.vesselOrFlight,
      blAwbNo: existing.blAwbNo,
      transporterName: existing.transporterName,
      transporterGstin: existing.transporterGstin,
      vehicleNo: existing.vehicleNo,
      ewayBillNo: existing.ewayBillNo,
      notes: existing.notes,
    });
    setContainers(
      existing.containers.map((c) => ({ key: `c${c.id}`, id: c.id, containerTypeId: c.containerTypeId, containerNo: c.containerNo, sealNo: c.sealNo, tareWeightKg: c.tareWeightKg, note: c.note }))
    );
  }, [existing]);

  /**
   * Load the existing lines once the candidate batches are in.
   *
   * A draft line carries its whole batch, because the fit maths needs the dims and weights,
   * and the shipment payload only carries a batch id — so this has to wait for the
   * candidates. `loadedFor` stops it running again and wiping edits in progress.
   */
  const [loadedFor, setLoadedFor] = useState<number | null>(null);
  useEffect(() => {
    if (!existing || isNew || !candidates.length || loadedFor === existing.id) return;
    const drafts: LineDraft[] = [];
    for (const l of existing.lines) {
      const batch = candidates.find((b) => b.id === l.packingBatchId);
      if (!batch) continue; // its batch is gone; the line is dropped rather than guessed at
      drafts.push({
        key: `l${l.id}`,
        id: l.id,
        packingBatchId: l.packingBatchId,
        cartons: l.cartons,
        qty: l.qty,
        // Containers are addressed by INDEX in the payload, so map the saved id across.
        containerIndex: l.containerId != null ? existing.containers.findIndex((c) => c.id === l.containerId) : null,
        batch,
      });
    }
    setLines(drafts);
    setLoadedFor(existing.id);
  }, [existing, candidates, isNew, loadedFor]);

  const buyer = buyers.find((b) => b.id === buyerId);
  const domestic = buyer?.market === 'DOMESTIC';

  /** Cartons already claimed by this draft, so the picker can cap what is left. */
  const claimed = useMemo(() => {
    const m = new Map<number, number>();
    for (const l of lines) m.set(l.packingBatchId, (m.get(l.packingBatchId) ?? 0) + l.cartons);
    return m;
  }, [lines]);

  const addLine = (b: PackingBatch) => {
    const left = b.availableCartons - (claimed.get(b.id) ?? 0);
    if (left <= 0) return;
    const perCarton = Math.max(1, Math.round(b.qty / Math.max(1, b.cartonCount)));
    // Into the LAST box, which is the one being filled — not the first, which may already
    // be full. "Plan the containers" is there to redistribute if it does not fit.
    const into = containers.length ? containers.length - 1 : null;
    setLines((ls) => [...ls, { key: `l${b.id}-${ls.length}`, packingBatchId: b.id, cartons: left, qty: Math.min(b.qty, left * perCarton), containerIndex: into, batch: b }]);
  };

  const patchLine = (key: string, next: Partial<LineDraft>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...next } : l)));

  /**
   * Add a box, and put the loose cartons in it.
   *
   * Without the second half of this, picking batches and THEN adding a container leaves
   * every line "not loaded" and the new box reading 0 CBM / 0%, which looks broken — the
   * fit bars are the whole point of the card. Adding a box means loading what is waiting.
   * Cartons already assigned to another container are left where the packer put them.
   */
  const addContainer = () => {
    const index = containers.length;
    setContainers((cs) => [...cs, { key: `n${index}-${Date.now()}`, containerTypeId: types[0]?.id ?? 0, containerNo: null, sealNo: null, tareWeightKg: null, note: null }]);
    setLines((ls) => ls.map((l) => (l.containerIndex == null ? { ...l, containerIndex: index } : l)));
  };

  /** What each container holds, live, through the mirrored engine. */
  const fits = containers.map((c, i) => {
    const mine = lines.filter((l) => l.containerIndex === i);
    const load = packedTotals(
      mine.map((l) => ({
        ...l.batch,
        cbmPerPiece: l.batch.cbmPerPiece,
        cbmPerCartonOverride: l.batch.cbmPerCartonOverride,
        cartonsTaken: l.cartons,
        piecesTaken: l.qty,
      }))
    );
    const t = types.find((x) => x.id === c.containerTypeId);
    return { key: c.key, load, type: t, fit: containerFit(load, { capacityCbm: t?.capacityCbm ?? 0, payloadKg: t?.payloadKg ?? 0 }, c.tareWeightKg ?? 0) };
  });

  const totals = packedTotals(
    lines.map((l) => ({ ...l.batch, cbmPerPiece: l.batch.cbmPerPiece, cbmPerCartonOverride: l.batch.cbmPerCartonOverride, cartonsTaken: l.cartons, piecesTaken: l.qty }))
  );

  /** Advisory guards — the server re-checks all of them under a row lock. */
  const refusal = useMemo(() => {
    if (!lines.length) return 'Pick at least one packed batch.';
    for (const l of lines) {
      const left = l.batch.availableCartons - ((claimed.get(l.packingBatchId) ?? 0) - l.cartons);
      if (l.cartons > left) return `Only ${l.batch.availableCartons} carton(s) of ${l.batch.productCode} are still here.`;
      const g = guardShipQty(l.batch.qty - l.batch.shippedQty, l.qty) ?? guardCartonFit(l.cartons, l.batch.piecesPerCarton, l.qty);
      if (g) return g;
    }
    const over = fits.find((f) => !f.fit.fits);
    if (over) return `${over.type?.code ?? 'A container'} is over capacity — add a container or take cartons off.`;
    return null;
  }, [lines, claimed, fits]);

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        shipDate: shipDate ? shipDate.toISOString() : null,
        ...header,
        containers: containers.map((c) => ({ id: c.id, containerTypeId: c.containerTypeId, containerNo: c.containerNo, sealNo: c.sealNo, tareWeightKg: c.tareWeightKg, note: c.note })),
        lines: lines.map((l) => ({ id: l.id, packingBatchId: l.packingBatchId, containerIndex: l.containerIndex ?? null, cartons: l.cartons, qty: l.qty })),
      };
      return isNew ? createShipment(body) : updateShipment(Number(id), body);
    },
    onSuccess: (s) => {
      message.success(`${s.number} saved.`);
      invalidateSales(qc);
      nav(`/sales/shipments/${s.id}`);
    },
    onError: (e) => message.error(apiError(e)),
  });

  const plan = useMutation({
    mutationFn: () => planShipment(lines.map((l) => ({ packingBatchId: l.packingBatchId, cartons: l.cartons, qty: l.qty }))),
    onSuccess: (r) => {
      // Auto-first, because the real question is "how many 40HQ do I need". The packer then
      // moves cartons by hand.
      setContainers(r.containers.map((c, i) => ({ key: `p${i}`, containerTypeId: c.containerTypeId, containerNo: null, sealNo: null, tareWeightKg: null, note: null })));
      setLines((ls) =>
        ls.map((l) => {
          const idx = r.containers.findIndex((c) => c.batchIds.includes(l.packingBatchId));
          return { ...l, containerIndex: idx >= 0 ? idx : null };
        })
      );
      message.success(`Suggested ${r.containers.length} container(s).`);
    },
    onError: (e) => message.error(apiError(e)),
  });

  if (!can('shipments.edit')) return <Result status="403" title="No access to dispatch" subTitle='This needs the "Edit shipments" permission.' />;

  return (
    <div>
      <Breadcrumb
        style={{ marginBottom: 12 }}
        items={[
          { title: <Link to="/"><HomeOutlined /></Link> },
          { title: <Link to="/sales">Dispatch</Link> },
          { title: <Link to="/sales/shipments">Shipments</Link> },
          { title: isNew ? 'New' : existing?.number ?? '' },
        ]}
      />
      <Space style={{ justifyContent: 'space-between', width: '100%', marginBottom: 12 }}>
        <Title level={4} style={{ margin: 0 }}>
          {isNew ? 'New shipment' : `Edit ${existing?.number ?? ''}`}
        </Title>
        <Space>
          <Button onClick={() => nav('/sales/shipments')}>Cancel</Button>
          <Button type="primary" loading={save.isPending} disabled={!!refusal} onClick={() => save.mutate()}>
            Save
          </Button>
        </Space>
      </Space>

      {refusal && <Alert type="warning" showIcon message={refusal} style={{ marginBottom: 12 }} />}

      <Card size="small" title="Shipment" style={{ marginBottom: 12 }}>
        <Row gutter={[12, 12]}>
          <Col xs={24} md={6}>
            <Text type="secondary">Buyer</Text>
            <Select
              showSearch
              optionFilterProp="label"
              style={{ width: '100%' }}
              placeholder="Whose goods"
              value={buyerId}
              disabled={lines.length > 0}
              onChange={setBuyerId}
              options={buyers.map((b: { id: number; name: string; market?: string | null }) => ({ value: b.id, label: `${b.name}${b.market === 'DOMESTIC' ? ' (domestic)' : ''}` }))}
            />
            {lines.length > 0 && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                Locked while lines are picked.
              </Text>
            )}
          </Col>
          <Col xs={24} md={6}>
            <Text type="secondary">Ship date</Text>
            <DatePicker id="ship-date" name="ship-date" style={{ width: '100%' }} value={shipDate} onChange={setShipDate} format="DD MMM YYYY" />
          </Col>
          <Col xs={24} md={6}>
            <Text type="secondary">Vessel / flight</Text>
            <Input id="ship-vessel" name="ship-vessel" value={header.vesselOrFlight ?? ''} onChange={(e) => setHeader((h) => ({ ...h, vesselOrFlight: e.target.value }))} />
          </Col>
          <Col xs={24} md={6}>
            <Text type="secondary">BL / AWB no.</Text>
            <Input id="ship-blawb" name="ship-blawb" value={header.blAwbNo ?? ''} onChange={(e) => setHeader((h) => ({ ...h, blAwbNo: e.target.value }))} />
          </Col>
        </Row>
      </Card>

      {/* Export customs versus domestic e-way: the same market gate the proforma uses. */}
      {buyerId != null &&
        (!domestic ? (
          <Card size="small" title="Export customs" style={{ marginBottom: 12 }}>
            <Row gutter={[12, 12]}>
              {[
                ['shippingBillNo', 'Shipping bill no.'],
                ['portOfLoading', 'Port of loading'],
                ['portOfDischarge', 'Port of discharge'],
                ['finalDestination', 'Final destination'],
              ].map(([k, label]) => (
                <Col xs={24} md={6} key={k}>
                  <Text type="secondary">{label}</Text>
                  <Input id={`ship-${k}`} name={`ship-${k}`} value={header[k] ?? ''} onChange={(e) => setHeader((h) => ({ ...h, [k]: e.target.value }))} />
                </Col>
              ))}
            </Row>
          </Card>
        ) : (
          <Card size="small" title="Movement (e-way bill)" style={{ marginBottom: 12 }}>
            <Row gutter={[12, 12]}>
              {[
                ['transporterName', 'Transporter'],
                ['transporterGstin', 'Transporter GSTIN'],
                ['vehicleNo', 'Vehicle no.'],
                ['ewayBillNo', 'E-way bill no.'],
              ].map(([k, label]) => (
                <Col xs={24} md={6} key={k}>
                  <Text type="secondary">{label}</Text>
                  <Input id={`ship-${k}`} name={`ship-${k}`} value={header[k] ?? ''} onChange={(e) => setHeader((h) => ({ ...h, [k]: e.target.value }))} />
                </Col>
              ))}
            </Row>
            <Text type="secondary" style={{ fontSize: 12 }}>
              All optional — typed in, there is no portal integration.
            </Text>
          </Card>
        ))}

      <Card
        size="small"
        title="Packed cartons to send"
        style={{ marginBottom: 12 }}
        extra={
          <Text type="secondary">
            {totals.cartons} carton(s) · {totals.pieces} pc · {totals.cbm.toFixed(3)} CBM · {totals.grossKg.toFixed(0)} kg
          </Text>
        }
      >
        {buyerId == null ? (
          <Alert type="info" showIcon message="Pick a buyer to see what is packed and ready." />
        ) : (
          <>
            <Space wrap style={{ marginBottom: 10 }}>
              {candidates
                .filter((b: PackingBatch) => b.availableCartons - (claimed.get(b.id) ?? 0) > 0)
                .map((b: PackingBatch) => (
                  <Button key={b.id} size="small" icon={<PlusOutlined />} onClick={() => addLine(b)}>
                    {b.productCode} · {b.availableCartons - (claimed.get(b.id) ?? 0)} ctn · {b.orderNumber}
                  </Button>
                ))}
              {!candidates.length && <Text type="secondary">Nothing is packed for this buyer yet.</Text>}
            </Space>
            <Table
              size="small"
              rowKey="key"
              pagination={false}
              dataSource={lines}
              locale={{ emptyText: 'Add packed batches above. A shipment may draw on several orders.' }}
              columns={[
                { title: 'Product', render: (_, l) => `${l.batch.productCode} — ${l.batch.productName}` },
                { title: 'Order', render: (_, l) => <Tag>{l.batch.orderNumber}</Tag> },
                {
                  title: 'Cartons',
                  width: 100,
                  render: (_, l) => (
                    <InputNumber
                      min={1}
                      max={l.batch.availableCartons}
                      value={l.cartons}
                      precision={0}
                      // Taking boxes off takes the pieces in them too. Otherwise reducing the
                      // cartons alone leaves a quantity those boxes cannot hold, and the guard
                      // refuses a save the packer has no obvious way to fix.
                      onChange={(v) => {
                        const cartons = v ?? 1;
                        const capacity = cartons * l.batch.piecesPerCarton;
                        patchLine(l.key, { cartons, qty: Math.min(l.qty, capacity) });
                      }}
                      style={{ width: '100%' }}
                    />
                  ),
                },
                {
                  title: 'Pieces',
                  width: 100,
                  render: (_, l) => <InputNumber min={1} value={l.qty} precision={0} onChange={(v) => patchLine(l.key, { qty: v ?? 1 })} style={{ width: '100%' }} />,
                },
                {
                  title: 'Container',
                  width: 160,
                  render: (_, l) => (
                    <Select
                      allowClear
                      placeholder="not loaded"
                      style={{ width: '100%' }}
                      value={l.containerIndex ?? undefined}
                      onChange={(v) => patchLine(l.key, { containerIndex: v ?? null })}
                      options={containers.map((c, i) => ({ value: i, label: c.containerNo || types.find((t) => t.id === c.containerTypeId)?.code || `#${i + 1}` }))}
                    />
                  ),
                },
                { title: 'CBM', width: 90, align: 'right' as const, render: (_, l) => round4(l.batch.cbmPerCarton * l.cartons).toFixed(3) },
                {
                  title: '',
                  width: 40,
                  render: (_, l) => <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} />,
                },
              ]}
            />
          </>
        )}
      </Card>

      <Card
        size="small"
        title="Containers"
        extra={
          <Space>
            <Button size="small" icon={<ThunderboltOutlined />} disabled={!lines.length} loading={plan.isPending} onClick={() => plan.mutate()}>
              Plan the containers
            </Button>
            <Button size="small" icon={<PlusOutlined />} onClick={addContainer}>
              Add a container
            </Button>
          </Space>
        }
      >
        {!containers.length && <Text type="secondary">No container — an LCL part load can ship without one.</Text>}
        <Row gutter={[12, 12]}>
          {containers.map((c, i) => {
            const f = fits[i];
            return (
              <Col xs={24} md={12} lg={8} key={c.key}>
                <Card size="small" style={{ borderColor: f?.fit.fits ? undefined : '#c62828' }}>
                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                    <Space.Compact style={{ width: '100%' }}>
                      <Select
                        style={{ width: 110 }}
                        value={c.containerTypeId}
                        onChange={(v) => setContainers((cs) => cs.map((x) => (x.key === c.key ? { ...x, containerTypeId: v } : x)))}
                        options={types.map((t) => ({ value: t.id, label: t.code }))}
                      />
                      <Input id={`ctr-no-${c.key}`} name={`ctr-no-${c.key}`} placeholder="Container no." value={c.containerNo ?? ''} onChange={(e) => setContainers((cs) => cs.map((x) => (x.key === c.key ? { ...x, containerNo: e.target.value } : x)))} />
                    </Space.Compact>
                    <Space.Compact style={{ width: '100%' }}>
                      <Input id={`ctr-seal-${c.key}`} name={`ctr-seal-${c.key}`} placeholder="Seal no." value={c.sealNo ?? ''} onChange={(e) => setContainers((cs) => cs.map((x) => (x.key === c.key ? { ...x, sealNo: e.target.value } : x)))} />
                      <InputNumber placeholder="Tare kg" value={c.tareWeightKg} onChange={(v) => setContainers((cs) => cs.map((x) => (x.key === c.key ? { ...x, tareWeightKg: v } : x)))} style={{ width: 110 }} />
                    </Space.Compact>

                    {/* Live fit. A capacity of 0 means LCL — no bar, because there is no limit. */}
                    {f?.type && f.type.capacityCbm > 0 ? (
                      <>
                        <div>
                          <Text type="secondary" style={{ fontSize: 11 }}>
                            Volume {f.load.cbm.toFixed(3)} / {f.type.capacityCbm} CBM
                          </Text>
                          <Progress percent={Math.min(100, f.fit.cbmPct)} status={f.fit.overCbm ? 'exception' : undefined} strokeColor={f.fit.overCbm ? undefined : '#6d4c41'} size="small" />
                        </div>
                        <div>
                          <Text type="secondary" style={{ fontSize: 11 }}>
                            Weight {f.fit.usedKg.toFixed(0)} / {f.type.payloadKg} kg (incl. tare)
                          </Text>
                          <Progress percent={Math.min(100, f.fit.kgPct)} status={f.fit.overKg ? 'exception' : undefined} strokeColor={f.fit.overKg ? undefined : '#6d4c41'} size="small" />
                        </div>
                      </>
                    ) : (
                      <Tag>part load — no stated capacity</Tag>
                    )}
                    {!f?.fit.fits && <Tag color="red">over capacity</Tag>}

                    <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {f?.load.cartons ?? 0} carton(s)
                      </Text>
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => {
                          setLines((ls) => ls.map((l) => (l.containerIndex === i ? { ...l, containerIndex: null } : l.containerIndex != null && l.containerIndex > i ? { ...l, containerIndex: l.containerIndex - 1 } : l)));
                          setContainers((cs) => cs.filter((x) => x.key !== c.key));
                        }}
                      />
                    </Space>
                  </Space>
                </Card>
              </Col>
            );
          })}
        </Row>
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          Freight and insurance are charges on the invoice, not here — a shipment carries no money.
        </Text>
      </Card>
    </div>
  );
}
