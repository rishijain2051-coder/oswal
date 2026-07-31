import { Table, Tag, Typography } from 'antd';
import type { DocumentTotals as Totals } from '../api/ops';
import { money } from '../util/format';

const { Text } = Typography;

interface Row {
  key: string;
  label: string;
  value: number;
  strong?: boolean;
  muted?: boolean;
}

/**
 * The money at the bottom of a proforma or an order, explained line by line.
 *
 * Everything here comes from the pricing engine — the component adds nothing up itself,
 * so it can never show a total the server disagrees with. An export arrives with
 * `taxed` false and simply has no tax rows to show.
 */
export default function DocumentTotals({ totals, symbol, compact }: { totals: Totals; symbol: string; compact?: boolean }) {
  // A response cached before this field existed would arrive without it, and reading
  // `totals.charges` off undefined white-screens the whole page. Render nothing instead;
  // the next refetch fills it in.
  if (!totals || !Array.isArray(totals.charges)) return null;

  const rows: Row[] = [];
  const showBreakdown = totals.charges.length > 0 || totals.taxed || totals.lineDiscount > 0;

  if (showBreakdown) {
    if (totals.lineDiscount > 0) rows.push({ key: 'gross', label: 'Items before discount', value: totals.grossSubtotal, muted: true });
    rows.push({ key: 'sub', label: 'Subtotal', value: totals.subtotal });
  }
  for (const [i, c] of totals.charges.entries()) {
    const suffix = totals.taxed && c.isTaxable && c.gstRatePct > 0 ? ` · GST ${c.gstRatePct}%` : !c.isTaxable ? ' · after tax' : '';
    rows.push({ key: `chg${i}`, label: `${c.name}${suffix}`, value: c.value });
  }
  if (totals.taxed) {
    if (totals.charges.some((c) => c.isTaxable)) rows.push({ key: 'taxable', label: 'Taxable value', value: totals.taxableValue });
    for (const t of totals.taxRows) {
      if (totals.intraState) {
        rows.push({ key: `cgst${t.ratePct}`, label: `CGST @ ${t.ratePct / 2}%`, value: t.cgst });
        rows.push({ key: `sgst${t.ratePct}`, label: `SGST @ ${t.ratePct / 2}%`, value: t.sgst });
      } else {
        rows.push({ key: `igst${t.ratePct}`, label: `IGST @ ${t.ratePct}%`, value: t.igst });
      }
    }
  }
  rows.push({ key: 'total', label: totals.taxed ? 'Grand total' : 'Total', value: totals.grandTotal, strong: true });

  return (
    <div style={{ maxWidth: compact ? 320 : 420, marginLeft: 'auto' }}>
      <Table<Row>
        rowKey="key"
        size="small"
        showHeader={false}
        pagination={false}
        dataSource={rows}
        columns={[
          {
            dataIndex: 'label',
            render: (v: string, r: Row) => (
              <Text strong={r.strong} type={r.muted ? 'secondary' : undefined} delete={r.muted} style={{ fontSize: r.strong ? 14 : 12 }}>
                {v}
              </Text>
            ),
          },
          {
            dataIndex: 'value',
            align: 'right' as const,
            width: 150,
            render: (v: number, r: Row) => (
              <Text strong={r.strong} type={r.muted ? 'secondary' : v < 0 ? 'danger' : undefined} delete={r.muted} style={{ fontSize: r.strong ? 14 : 12, whiteSpace: 'nowrap' }}>
                {money(v, symbol)}
              </Text>
            ),
          },
        ]}
      />
      {totals.taxed ? (
        <div style={{ textAlign: 'right', marginTop: 6 }}>
          <Tag color={totals.intraState ? 'geekblue' : 'purple'}>{totals.intraState ? 'Intra-state · CGST + SGST' : 'Inter-state · IGST'}</Tag>
        </div>
      ) : (
        <div style={{ textAlign: 'right', marginTop: 6 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Export supply — zero rated, no GST
          </Text>
        </div>
      )}
    </div>
  );
}
