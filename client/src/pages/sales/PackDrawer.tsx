import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Drawer, Input, InputNumber, Space, Table, Tag, Typography, message } from 'antd';
import { invalidateSales, packBatches, type PackBatchInput, type PackQueueRow } from '../../api/sales';
import { apiError } from '../../api/client';
import { cartonCbm, cartonsFor, CBM_MISMATCH_PCT, guardPackQty, round4 } from '../../util/shipping';

const { Text } = Typography;

/**
 * Pack one or more order lines.
 *
 * Everything numeric on this drawer comes from `client/src/util/shipping.ts`, the mirror of
 * the server engine — so the carton count and the CBM shown here are the ones the API will
 * compute, and `guardPackQty` refuses exactly what the server is about to refuse.
 */
interface Row {
  key: number;
  src: PackQueueRow;
  qty: number | null;
  piecesPerCarton: number | null;
  cartonCount: number | null;
  packLengthIn: number | null;
  packWidthIn: number | null;
  packHeightIn: number | null;
  netWeightKg: number | null;
  grossWeightKg: number | null;
  cbmOverride: number | null;
  marks: string;
}

const toRow = (r: PackQueueRow): Row => ({
  key: r.orderLineId,
  src: r,
  // Pre-filled from the product master; the packer overrides only what differs.
  qty: r.availableToPack,
  piecesPerCarton: r.piecesPerCarton ?? 1,
  cartonCount: null,
  packLengthIn: r.packLengthIn,
  packWidthIn: r.packWidthIn,
  packHeightIn: r.packHeightIn,
  netWeightKg: r.netWeightKg,
  grossWeightKg: r.grossWeightKg,
  cbmOverride: null,
  marks: '',
});

export default function PackDrawer({ rows: initial, onClose }: { rows: PackQueueRow[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<Row[]>(initial.map(toRow));

  const patch = (key: number, next: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...next } : r)));

  /** What each row works out to, through the shared engine. */
  const derived = rows.map((r) => {
    const count = cartonsFor(r.qty ?? 0, r.piecesPerCarton);
    const cartons = r.cartonCount ?? count.total;
    /**
     * Changing a dimension or the pieces per carton means the product's stored per-piece
     * volume described a DIFFERENT box, so it is dropped here exactly as the server drops it
     * — which is what makes the figure on screen match the one that gets saved.
     */
    const dimsChanged =
      r.packLengthIn !== r.src.packLengthIn ||
      r.packWidthIn !== r.src.packWidthIn ||
      r.packHeightIn !== r.src.packHeightIn ||
      r.piecesPerCarton !== (r.src.piecesPerCarton ?? 1);
    const volume = cartonCbm({
      packLengthIn: r.packLengthIn,
      packWidthIn: r.packWidthIn,
      packHeightIn: r.packHeightIn,
      piecesPerCarton: r.piecesPerCarton,
      cbmPerPiece: dimsChanged ? null : r.src.cbmPerPiece,
      cbmPerCartonOverride: r.cbmOverride,
    });
    const refusal = r.qty ? guardPackQty(r.src.availableToPack, r.qty) : 'Enter how many pieces are being packed.';
    return { row: r, count, cartons, volume, refusal };
  });

  const firstError = derived.find((d) => d.refusal)?.refusal ?? null;
  const totals = derived.reduce(
    (a, d) => ({
      cartons: a.cartons + d.cartons,
      pieces: a.pieces + (d.row.qty ?? 0),
      cbm: round4(a.cbm + d.volume.value * d.cartons),
      grossKg: a.grossKg + (d.row.grossWeightKg ?? 0) * (d.row.qty ?? 0),
    }),
    { cartons: 0, pieces: 0, cbm: 0, grossKg: 0 }
  );

  const save = useMutation({
    mutationFn: () => {
      const batches: PackBatchInput[] = derived.map((d) => ({
        productId: d.row.src.productId,
        orderLineId: d.row.src.orderLineId,
        qty: d.row.qty!,
        cartonCount: d.cartons,
        piecesPerCarton: d.row.piecesPerCarton ?? 1,
        packLengthIn: d.row.packLengthIn,
        packWidthIn: d.row.packWidthIn,
        packHeightIn: d.row.packHeightIn,
        netWeightKg: d.row.netWeightKg,
        grossWeightKg: d.row.grossWeightKg,
        cbmPerCartonOverride: d.row.cbmOverride,
        shippingMarks: d.row.marks || null,
      }));
      return packBatches(batches);
    },
    onSuccess: () => {
      message.success(`Packed ${totals.pieces} pc into ${totals.cartons} carton(s).`);
      invalidateSales(qc);
      onClose();
    },
    onError: (e) => message.error(apiError(e)),
  });

  return (
    <Drawer
      open
      width={1080}
      title={rows.length === 1 ? `Pack ${rows[0].src.productCode}` : `Pack ${rows.length} lines`}
      onClose={onClose}
      footer={
        <Space style={{ justifyContent: 'space-between', width: '100%' }}>
          <Text type="secondary">
            {totals.cartons} carton(s) · {totals.pieces} pc · {totals.cbm.toFixed(3)} CBM · {totals.grossKg.toFixed(2)} kg gross
          </Text>
          <Space>
            <Button onClick={onClose}>Cancel</Button>
            <Button type="primary" loading={save.isPending} disabled={!!firstError} onClick={() => save.mutate()}>
              Pack
            </Button>
          </Space>
        </Space>
      }
    >
      {firstError && <Alert type="warning" showIcon message={firstError} style={{ marginBottom: 12 }} />}

      <Table
        size="small"
        /**
         * The row key lives on `d.row`, not on `d` — the table is fed `derived`, which wraps
         * each row with what it works out to. A bare `rowKey="key"` read `undefined` for every
         * row, so React had no stable identity for any of them and could carry one row's input
         * state onto another.
         */
        rowKey={(d) => d.row.key}
        pagination={false}
        dataSource={derived}
        columns={[
          // A `key` per column too: none of them has a `dataIndex` to fall back on.
          {
            title: 'Line',
            key: 'line',
            width: 200,
            render: (_, d) => (
              <div>
                <div style={{ fontWeight: 600 }}>{d.row.src.productCode}</div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {d.row.src.orderNumber} · {d.row.src.availableToPack} to pack
                </Text>
              </div>
            ),
          },
          {
            title: 'Pieces',
            key: 'qty',
            width: 90,
            render: (_, d) => <InputNumber min={1} max={d.row.src.availableToPack} value={d.row.qty} precision={0} onChange={(v) => patch(d.row.key, { qty: v })} style={{ width: '100%' }} />,
          },
          {
            title: 'Pcs / carton',
            key: 'per',
            width: 100,
            render: (_, d) => <InputNumber min={1} value={d.row.piecesPerCarton} precision={0} onChange={(v) => patch(d.row.key, { piecesPerCarton: v })} style={{ width: '100%' }} />,
          },
          {
            title: 'Cartons',
            key: 'cartons',
            width: 130,
            render: (_, d) => (
              <div>
                <InputNumber min={1} value={d.row.cartonCount ?? d.count.total} precision={0} onChange={(v) => patch(d.row.key, { cartonCount: v })} style={{ width: '100%' }} />
                {d.count.lastPieces > 0 && (
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    last carton holds {d.count.lastPieces} pc
                  </Text>
                )}
              </div>
            ),
          },
          {
            title: 'Carton L × W × H (in)',
            key: 'dims',
            width: 210,
            render: (_, d) => (
              <Space.Compact>
                <InputNumber placeholder="L" value={d.row.packLengthIn} onChange={(v) => patch(d.row.key, { packLengthIn: v })} style={{ width: 66 }} />
                <InputNumber placeholder="W" value={d.row.packWidthIn} onChange={(v) => patch(d.row.key, { packWidthIn: v })} style={{ width: 66 }} />
                <InputNumber placeholder="H" value={d.row.packHeightIn} onChange={(v) => patch(d.row.key, { packHeightIn: v })} style={{ width: 66 }} />
              </Space.Compact>
            ),
          },
          {
            title: 'Net / gross kg per pc',
            key: 'weights',
            width: 150,
            render: (_, d) => (
              <Space.Compact>
                <InputNumber placeholder="net" value={d.row.netWeightKg} onChange={(v) => patch(d.row.key, { netWeightKg: v })} style={{ width: 72 }} />
                <InputNumber placeholder="gross" value={d.row.grossWeightKg} onChange={(v) => patch(d.row.key, { grossWeightKg: v })} style={{ width: 72 }} />
              </Space.Compact>
            ),
          },
          {
            title: 'CBM / carton',
            key: 'cbm',
            width: 170,
            render: (_, d) => (
              <div>
                <InputNumber
                  placeholder={d.volume.value.toFixed(4)}
                  value={d.row.cbmOverride}
                  step={0.001}
                  onChange={(v) => patch(d.row.key, { cbmOverride: v })}
                  style={{ width: '100%' }}
                />
                <Space size={4} style={{ marginTop: 2 }}>
                  <Tag color={d.volume.source === 'OVERRIDE' ? 'purple' : d.volume.source === 'STORED' ? 'blue' : 'default'} style={{ marginInlineEnd: 0 }}>
                    {d.volume.source === 'OVERRIDE' ? 'measured' : d.volume.source === 'STORED' ? 'from product' : 'from dims'}
                  </Tag>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {d.volume.value.toFixed(4)}
                  </Text>
                </Space>
                {/* Never resolved silently: show both figures and let a human decide. */}
                {d.volume.mismatchPct > CBM_MISMATCH_PCT && d.volume.derived != null && (
                  <Text type="warning" style={{ fontSize: 11, display: 'block' }}>
                    dims say {d.volume.derived.toFixed(4)} ({d.volume.mismatchPct.toFixed(1)}% apart)
                  </Text>
                )}
              </div>
            ),
          },
          {
            title: 'Shipping marks',
            key: 'marks',
            render: (_, d) => <Input value={d.row.marks} placeholder="stencilled on the box" onChange={(e) => patch(d.row.key, { marks: e.target.value })} />,
          },
        ]}
      />
    </Drawer>
  );
}
