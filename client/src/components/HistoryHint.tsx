import { Button, Divider, Empty, Popover, Space, Tag, Tooltip, Typography } from 'antd';
import { HistoryOutlined, WarningOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import dayjs from 'dayjs';
import { outlierOf, usePriceSuggestion, useRateSuggestion, type Suggestion } from '../api/suggest';
import { money, num } from '../util/format';

const { Text } = Typography;

const LINK_BASE: Record<string, string> = {
  product: '/products',
  order: '/operations/orders',
  proforma: '/operations/proformas',
  stock: '/operations/stock',
  worker: '/manforce/workers',
};

/**
 * "What did we use last time?" beside a figure.
 *
 * Shows the most recent comparable value inline, so the answer is visible without
 * clicking anything; the popover holds every source, where each figure came from and
 * when. An amber note appears when the typed figure is well away from the average of
 * the window — never blocking, because the operator may have a good reason, but a
 * ₹2,600 typed for ₹260 is worth catching at the moment it happens.
 */
export default function HistoryHint({
  suggestion,
  value,
  outlierPct = 25,
  windowDays = 365,
  symbol = '₹',
  unitSuffix,
  onApply,
  compact,
  loading,
}: {
  suggestion: Suggestion | null | undefined;
  /** The figure currently in the field, for the out-of-line check. */
  value?: number | null;
  outlierPct?: number;
  windowDays?: number;
  symbol?: string;
  /** e.g. "/pc" or "/CFT", appended to every figure shown. */
  unitSuffix?: string;
  /** Given, the popover offers one-click apply of any past figure. */
  onApply?: (value: number) => void;
  /** Icon only, for tight table rows. */
  compact?: boolean;
  loading?: boolean;
}) {
  const primary = suggestion?.primary ?? null;
  const verdict = outlierOf(value, primary, outlierPct);
  const fig = (v: number) => `${money(v, symbol, v % 1 === 0 ? 0 : 2)}${unitSuffix ?? ''}`;

  if (!primary) {
    return compact ? (
      <Tooltip title={loading ? 'Looking up what this cost before…' : `Nothing comparable in the last ${windowDays} days.`}>
        <Button type="text" size="small" icon={<HistoryOutlined />} disabled style={{ opacity: 0.35 }} />
      </Tooltip>
    ) : (
      <Text type="secondary" style={{ fontSize: 12 }}>
        {loading ? 'checking history…' : 'no history yet'}
      </Text>
    );
  }

  const content = (
    <div style={{ maxWidth: 460 }}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {suggestion!.name} · last {windowDays} days
      </Text>
      {suggestion!.sources.map((s, i) => (
        <div key={s.kind} style={{ marginTop: i ? 12 : 8 }}>
          <Space size={6} wrap>
            <Text strong>{s.label}</Text>
            <Tag color="blue" style={{ margin: 0 }}>
              {fig(s.last!.value)}
            </Tag>
            {s.count > 1 && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {s.count} times · {fig(s.min)}–{fig(s.max)} · avg {fig(s.avg)}
              </Text>
            )}
          </Space>
          <div style={{ marginTop: 4 }}>
            {s.occurrences.slice(0, 5).map((o, j) => (
              <div key={j} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, padding: '2px 0' }}>
                <span>
                  {o.link ? (
                    <Link to={`${LINK_BASE[o.link.type] ?? ''}/${o.link.id}`}>{o.label}</Link>
                  ) : (
                    o.label
                  )}
                  {o.detail && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {' '}
                      · {o.detail}
                    </Text>
                  )}
                </span>
                <span style={{ whiteSpace: 'nowrap' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {dayjs(o.date).format('DD MMM YY')}
                  </Text>{' '}
                  {onApply ? (
                    <Button type="link" size="small" style={{ padding: '0 4px' }} onClick={() => onApply(o.value)}>
                      {fig(o.value)}
                    </Button>
                  ) : (
                    <b>{fig(o.value)}</b>
                  )}
                </span>
              </div>
            ))}
            {s.count > 5 && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                …and {s.count - 5} more
              </Text>
            )}
          </div>
        </div>
      ))}
      {verdict.flag && (
        <>
          <Divider style={{ margin: '10px 0' }} />
          <Text type="warning" style={{ fontSize: 12 }}>
            <WarningOutlined /> {fig(value!)} is {Math.abs(verdict.pct).toFixed(0)}% {verdict.flag === 'HIGH' ? 'above' : 'below'} the average of {verdict.count} past uses ({fig(verdict.reference)}).
          </Text>
        </>
      )}
      {onApply && (
        <>
          <Divider style={{ margin: '10px 0' }} />
          <Button size="small" type="primary" onClick={() => onApply(primary.last!.value)}>
            Use {fig(primary.last!.value)}
          </Button>
        </>
      )}
    </div>
  );

  const trigger = compact ? (
    <Button
      type="text"
      size="small"
      icon={verdict.flag ? <WarningOutlined style={{ color: '#d46b08' }} /> : <HistoryOutlined />}
      style={{ color: verdict.flag ? '#d46b08' : undefined }}
    />
  ) : (
    <span style={{ cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' }}>
      <Text type={verdict.flag ? 'warning' : 'secondary'} style={{ fontSize: 12 }}>
        {verdict.flag ? <WarningOutlined /> : <HistoryOutlined />} {fig(primary.last!.value)}
        {primary.count > 1 ? ` · ${primary.count}×` : ''}
      </Text>
    </span>
  );

  return (
    <Popover content={content} title={null} trigger="click" placement="topRight">
      {trigger}
    </Popover>
  );
}

/** The one-line version for under a form field. */
export function HistoryNote({ suggestion, value, outlierPct = 25, symbol = '₹', unitSuffix, onApply }: { suggestion: Suggestion | null | undefined; value?: number | null; outlierPct?: number; symbol?: string; unitSuffix?: string; onApply?: (v: number) => void }) {
  const primary = suggestion?.primary ?? null;
  const verdict = outlierOf(value, primary, outlierPct);
  if (!primary?.last) return null;
  const fig = (v: number) => `${money(v, symbol, v % 1 === 0 ? 0 : 2)}${unitSuffix ?? ''}`;

  return (
    <span style={{ fontSize: 12 }}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {primary.label}: {onApply ? <a onClick={() => onApply(primary.last!.value)}>{fig(primary.last!.value)}</a> : <b>{fig(primary.last!.value)}</b>} — {primary.last.label},{' '}
        {dayjs(primary.last.date).format('DD MMM YY')}
        {primary.count > 1 ? ` · ${primary.count} uses, ${fig(primary.min)}–${fig(primary.max)}` : ''}
      </Text>
      {verdict.flag && (
        <>
          <br />
          <Text type="warning" style={{ fontSize: 12 }}>
            <WarningOutlined /> {Math.abs(verdict.pct).toFixed(0)}% {verdict.flag === 'HIGH' ? 'above' : 'below'} the {num(verdict.count, 0)}-use average of {fig(verdict.reference)}
          </Text>
        </>
      )}
    </span>
  );
}

/**
 * What this product has sold for — this buyer first, then everyone, same currency.
 *
 * Its own component so it can be dropped into a table cell: each row needs its own
 * query, and a hook cannot be called inside a render loop.
 */
export function PriceHint({ productId, buyerId, currency, symbol, value, onApply, compact = true }: { productId?: number | null; buyerId?: number | null; currency?: string | null; symbol?: string; value?: number | null; onApply?: (v: number) => void; compact?: boolean }) {
  const { data, isFetching } = usePriceSuggestion(productId, buyerId, currency);
  return (
    <HistoryHint
      compact={compact}
      loading={isFetching}
      suggestion={data ?? null}
      value={value}
      outlierPct={data?.outlierPct ?? 25}
      windowDays={data?.windowDays ?? 365}
      symbol={symbol ?? '₹'}
      onApply={onApply}
    />
  );
}

/** A jobwork, in-house piece, purchase or wage rate, with what it has been before. */
export function RateHint({
  kind,
  stage,
  vendorId,
  rawItemId,
  supplierId,
  tradeId,
  payType,
  value,
  onApply,
  unitSuffix,
  compact = true,
}: {
  kind: 'JOBWORK' | 'LABOUR' | 'PURCHASE' | 'WORKER';
  stage?: string;
  vendorId?: number | null;
  rawItemId?: number | null;
  supplierId?: number | null;
  tradeId?: number | null;
  payType?: string;
  value?: number | null;
  onApply?: (v: number) => void;
  unitSuffix?: string;
  compact?: boolean;
}) {
  const { data, isFetching } = useRateSuggestion({ kind, stage, vendorId, rawItemId, supplierId, tradeId, payType });
  return (
    <HistoryHint
      compact={compact}
      loading={isFetching}
      suggestion={data ?? null}
      value={value}
      outlierPct={data?.outlierPct ?? 25}
      windowDays={data?.windowDays ?? 365}
      unitSuffix={unitSuffix}
      onApply={onApply}
    />
  );
}

/** Shared empty state for the change-log lists. */
export function NoHistory({ what }: { what: string }) {
  return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`No changes recorded for this ${what} yet.`} />;
}
