import { useEffect, useState } from 'react';
import { Alert, App, Button, Drawer, InputNumber, Select, Space, Table, Tag, Typography } from 'antd';
import { HomeOutlined, ShopOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, apiError } from '../../../api/client';
import { OPS_KEYS, useStageLines, useSuppliers, type Order, type OrderLineDto, type StageCell } from '../../../api/ops';
import { useAuth } from '../../../auth/AuthContext';
import { money } from '../../../util/format';
import { RateHint } from '../../../components/HistoryHint';

const { Text } = Typography;

interface StageEdit {
  id: number;
  name: string;
  sortOrder: number;
  vendorId: number | null;
  jobworkRate: number;
  /** In-house piece rate. Zero is normal: that stage is day-wage work. */
  labourRate: number;
  /** Steps engaged at one agreed price share this label. Blank = paid on its own. */
  pieceGroup: string | null;
}

/**
 * Who does each stage of one order line. Every stage is independent, so any mix
 * works — stages 1-3 in-house, 4 at a vendor, 5-6 back in-house.
 */
export default function RoutingDrawer({ order, line, onClose }: { order: Order; line: OrderLineDto | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { can } = useAuth();
  const { data: vendors } = useSuppliers('JOBWORK');
  const { data: stageLines } = useStageLines();

  /** Routing and pricing are separate permissions — this drawer edits both. */
  const canSetRates = can('board.rates');

  const [stageLineId, setStageLineId] = useState<number | null>(null);
  const [stages, setStages] = useState<StageEdit[]>([]);
  const [bulkVendor, setBulkVendor] = useState<number>(0);
  const [bulkFrom, setBulkFrom] = useState<number>();
  const [bulkTo, setBulkTo] = useState<number>();

  const started = (line?.history.length ?? 0) > 0;

  useEffect(() => {
    if (!line) return;
    setStageLineId(line.stageLineId ?? null);
    setStages(line.board.stages.map((s: StageCell) => ({ id: s.id, name: s.name, sortOrder: s.sortOrder, vendorId: s.vendorId, jobworkRate: s.jobworkRate ?? 0, labourRate: s.labourRate ?? 0, pieceGroup: s.pieceGroup ?? null })));
    setBulkVendor(0);
    setBulkFrom(undefined);
    setBulkTo(undefined);
  }, [line?.id, line?.history.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/order-lines/${line!.id}/routing`, {
        ...(stageLineId !== (line!.stageLineId ?? null) ? { stageLineId } : {}),
        /**
         * The rate fields are OMITTED, not zeroed, for somebody who may route but not price.
         *
         * The server decides which permission a routing save needs by looking at whether any
         * rate is present in the payload, so sending them always meant a routing-only role
         * was refused every change it was supposed to be able to make. Sending zeroes instead
         * would be worse: the drawer seeds hidden rates as 0, so a save would have wiped the
         * real ones. `undefined` keys drop out of the JSON body.
         */
        stages: stages.map((s) => ({
          id: s.id,
          vendorId: s.vendorId,
          jobworkRate: canSetRates ? s.jobworkRate : undefined,
          labourRate: canSetRates ? s.labourRate : undefined,
          pieceGroup: canSetRates ? s.pieceGroup : undefined,
        })),
      }),
    onSuccess: () => {
      message.success('Saved.');
      for (const key of OPS_KEYS) qc.invalidateQueries({ queryKey: key });
      onClose();
    },
    onError: (e) => message.error(apiError(e)),
  });

  if (!line) return <Drawer open={false} onClose={onClose} />;

  const changingLine = stageLineId !== (line.stageLineId ?? null);
  // Both warnings are about rates, so neither is asked when the rates are withheld — the
  // drawer seeds those as 0, which would report every outsourced stage as unpriced to
  // somebody who cannot see the real figure and could not have set it.
  const missingRate = canSetRates ? stages.find((s) => s.vendorId && s.jobworkRate <= 0) : undefined;
  // A vendor is paid for the stage, so an in-house piece rate on it would be a second
  // charge for the same work.
  const doublePaid = canSetRates ? stages.find((s) => s.vendorId && s.labourRate > 0) : undefined;

  /**
   * A short list of labels rather than a free-text box. Two steps only belong to the same job
   * if somebody picks the SAME label for both, and typing "Job A" against one and "job a"
   * against the next would silently make two groups of one.
   */
  const groupOptions = ['Job A', 'Job B', 'Job C', 'Job D'].map((g) => ({ label: g, value: g }));

  const applyRange = () => {
    if (bulkFrom == null || bulkTo == null) return;
    const lo = Math.min(bulkFrom, bulkTo);
    const hi = Math.max(bulkFrom, bulkTo);
    setStages((prev) => prev.map((s) => (s.sortOrder >= lo && s.sortOrder <= hi ? { ...s, vendorId: bulkVendor || null, labourRate: bulkVendor ? 0 : s.labourRate } : s)));
  };

  const cols = [
    { title: '#', dataIndex: 'sortOrder', width: 44, render: (v: number) => v + 1 },
    { title: 'Stage', dataIndex: 'name' },
    {
      title: 'Done by',
      dataIndex: 'vendorId',
      width: 210,
      render: (v: number | null, r: StageEdit) => (
        <Select
          size="small"
          style={{ width: 200 }}
          value={v ?? 0}
          onChange={(val) => setStages((prev) => prev.map((s) => (s.id === r.id ? { ...s, vendorId: val || null, labourRate: val ? 0 : s.labourRate } : s)))}
          options={[
            { label: 'In-house', value: 0 },
            ...(vendors ?? []).map((x) => ({ label: x.name, value: x.id })),
          ]}
        />
      ),
    },
    {
      title: 'Jobwork ₹/pc',
      dataIndex: 'jobworkRate',
      width: 130,
      render: (v: number, r: StageEdit) => (
        <InputNumber
          size="small"
          min={0}
          step={1}
          style={{ width: 110 }}
          value={v}
          disabled={!r.vendorId}
          status={r.vendorId && v <= 0 ? 'error' : undefined}
          onChange={(val) => setStages((prev) => prev.map((s) => (s.id === r.id ? { ...s, jobworkRate: val ?? 0 } : s)))}
        />
      ),
    },
    {
      title: '',
      key: 'jobworkHistory',
      width: 34,
      render: (_: unknown, r: StageEdit) => (
        <RateHint
          kind="JOBWORK"
          stage={r.name}
          vendorId={r.vendorId}
          value={r.jobworkRate}
          unitSuffix="/pc"
          onApply={(v) => setStages((prev) => prev.map((s) => (s.id === r.id ? { ...s, jobworkRate: v } : s)))}
        />
      ),
    },
    {
      title: 'Labour ₹/pc',
      dataIndex: 'labourRate',
      width: 130,
      render: (v: number, r: StageEdit) => (
        <InputNumber
          size="small"
          min={0}
          step={1}
          style={{ width: 110 }}
          value={v}
          disabled={!!r.vendorId}
          placeholder="day wage"
          onChange={(val) => setStages((prev) => prev.map((s) => (s.id === r.id ? { ...s, labourRate: val ?? 0 } : s)))}
        />
      ),
    },
    {
      title: '',
      key: 'labourHistory',
      width: 34,
      render: (_: unknown, r: StageEdit) => (
        <RateHint
          kind="LABOUR"
          stage={r.name}
          value={r.labourRate}
          unitSuffix="/pc"
          onApply={(v) => setStages((prev) => prev.map((s) => (s.id === r.id ? { ...s, labourRate: v } : s)))}
        />
      ),
    },
    {
      /**
       * A run of steps engaged at one price. Give the same label to consecutive steps, put the
       * whole ₹/pc on the LAST of them and leave the others blank — the server enforces both,
       * so the agreed price is stored once and the run is paid once.
       */
      title: 'Paid together as',
      dataIndex: 'pieceGroup',
      width: 150,
      render: (v: string | null, r: StageEdit) => (
        <Select
          size="small"
          allowClear
          style={{ width: 132 }}
          value={v ?? undefined}
          placeholder="on its own"
          disabled={!!r.vendorId || !canSetRates}
          options={groupOptions}
          onChange={(val) => setStages((prev) => prev.map((s) => (s.id === r.id ? { ...s, pieceGroup: (val as string) ?? null } : s)))}
        />
      ),
    },
  ];

  const jobworkTotal = stages.reduce((a, s) => a + (s.vendorId ? s.jobworkRate * line.qty : 0), 0);
  const labourTotal = stages.reduce((a, s) => a + (!s.vendorId ? s.labourRate * line.qty : 0), 0);

  // A readable summary of the split, e.g. "1-3 in-house · 4 Shakti · 5-6 in-house".
  const runs: { label: string; from: number; to: number }[] = [];
  for (const s of stages) {
    const label = s.vendorId ? vendors?.find((v) => v.id === s.vendorId)?.name ?? 'Vendor' : 'in-house';
    const last = runs[runs.length - 1];
    if (last && last.label === label && last.to === s.sortOrder - 1) last.to = s.sortOrder;
    else runs.push({ label, from: s.sortOrder, to: s.sortOrder });
  }

  return (
    <Drawer
      open
      width={640}
      onClose={onClose}
      title={
        <Space direction="vertical" size={0}>
          <span>Who makes this?</span>
          <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
            {line.product.factoryCode} — {line.product.name} · {line.qty} pcs
          </Text>
        </Space>
      }
      footer={
        <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="primary" loading={save.isPending} disabled={(changingLine && started) || !!missingRate || !!doublePaid} onClick={() => save.mutate()}>
            Save routing
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <div>
          <Text type="secondary">Stage line</Text>
          <Select
            style={{ width: '100%' }}
            value={stageLineId ?? undefined}
            placeholder="Pick the route this line follows"
            disabled={started}
            onChange={(v) => setStageLineId(v ?? null)}
            options={(stageLines ?? []).map((l) => ({ label: `${l.code} — ${l.name} (${l.steps.length} stages)`, value: l.id }))}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            {started ? 'Locked — pieces have already moved. Undo the movements to change the route.' : 'Comes from the product; change it here for this order only.'}
          </Text>
        </div>

        {changingLine && started && <Alert type="error" showIcon message="Changing the stage line would wipe this line's movement history." />}
        {changingLine && !started && <Alert type="warning" showIcon message="Saving a new stage line rebuilds the stages below from scratch." />}

        <div>
          <Text strong>Hand stages to a vendor</Text>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
            Set each stage below, or fill a range in one go. Any pattern is allowed — outsource just the middle if that is how it runs.
          </Text>
          <Space wrap>
            <Select
              size="small"
              style={{ width: 190 }}
              value={bulkVendor}
              onChange={setBulkVendor}
              options={[{ label: 'In-house', value: 0 }, ...(vendors ?? []).map((x) => ({ label: x.name, value: x.id }))]}
            />
            <Text type="secondary">does stages</Text>
            <Select size="small" style={{ width: 150 }} placeholder="from" value={bulkFrom} onChange={setBulkFrom} options={stages.map((s) => ({ label: `${s.sortOrder + 1}. ${s.name}`, value: s.sortOrder }))} />
            <Text type="secondary">to</Text>
            <Select size="small" style={{ width: 150 }} placeholder="to" value={bulkTo} onChange={setBulkTo} options={stages.map((s) => ({ label: `${s.sortOrder + 1}. ${s.name}`, value: s.sortOrder }))} />
            <Button size="small" disabled={bulkFrom == null || bulkTo == null} onClick={applyRange}>
              Apply
            </Button>
          </Space>
        </div>

        <Table<StageEdit> rowKey="id" size="small" columns={cols as any} dataSource={stages} pagination={false} />

        {missingRate && <Alert type="error" showIcon message={`Set a jobwork rate for "${missingRate.name}" — a vendor stage at ₹0 would bill nothing.`} />}
        {doublePaid && (
          <Alert
            type="error"
            showIcon
            message={`Clear the labour rate on "${doublePaid.name}"`}
            description="It is going to a vendor, so the vendor is paid for that stage — leaving an in-house piece rate on it would pay for the same work twice."
          />
        )}

        {stages.length > 0 && (
          <Alert
            type="info"
            showIcon
            message={
              <Space size={4} wrap>
                {runs.map((r, i) => (
                  <Tag key={i} color={r.label === 'in-house' ? 'default' : 'volcano'} icon={r.label === 'in-house' ? <HomeOutlined /> : <ShopOutlined />}>
                    {r.from === r.to ? r.from + 1 : `${r.from + 1}–${r.to + 1}`} {r.label}
                  </Tag>
                ))}
              </Space>
            }
            description={
              <span>
                {jobworkTotal > 0 ? `Jobwork at full quantity: ${money(jobworkTotal, '₹')}. ` : 'Nothing outsourced — all in-house. '}
                {labourTotal > 0
                  ? `In-house piece work at full quantity: ${money(labourTotal, '₹')} — earned by whoever is named on each clearance.`
                  : 'No in-house piece rates, so those stages are day-wage work.'}
              </span>
            }
          />
        )}
      </Space>
    </Drawer>
  );
}
