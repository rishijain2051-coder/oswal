import { Card, Empty, Space, Statistic, Table, Tag, Tooltip, Typography } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { money, num } from '../util/format';

const { Text } = Typography;

export interface ForexCurrencyRow {
  currency: string;
  symbol: string;
  totalFcy: number;
  totalInrAtSnapshot: number;
  totalInrAtCurrent: number;
  forexGainLoss: number;
  orderCount: number;
  averageSnapshotRate: number;
  currentRate: number;
}

export interface ForexSummary {
  byCurrency: ForexCurrencyRow[];
  totalInrAtSnapshot: number;
  totalInrAtCurrent: number;
  netForexGainLoss: number;
  hasForeignExposure: boolean;
}

export const useForexSummary = () =>
  useQuery<ForexSummary>({ queryKey: ['finance-receivables-summary'], queryFn: async () => (await api.get('/finance/receivables/summary')).data });

/** Green when the rupee value of what we are owed has risen, red when it has fallen. */
function GainLoss({ value, compact }: { value: number; compact?: boolean }) {
  if (Math.abs(value) < 0.5)
    return (
      <Text type="secondary" style={{ fontSize: 12 }}>
        no change
      </Text>
    );
  const up = value > 0;
  return (
    <Text style={{ color: up ? '#2e7d32' : '#c62828', fontSize: compact ? 12 : 14, whiteSpace: 'nowrap' }}>
      {up ? <ArrowUpOutlined /> : <ArrowDownOutlined />} {money(Math.abs(value), '₹')}
    </Text>
  );
}

/**
 * What is outstanding, per currency, valued two ways: at the rate each order was booked
 * at and at today's. The gap is UNREALISED — nothing is booked until the money actually
 * arrives — which is why it is shown as a movement rather than folded into a total.
 */
export default function ForexSummaryCard({ compact }: { compact?: boolean }) {
  const { data, isLoading, isError } = useForexSummary();
  const rows = data?.byCurrency ?? [];

  // Without this, a failed request renders the confident claim that nothing is owed.
  if (isError) {
    return (
      <Card size="small" title="Currency exposure">
        <Text type="secondary">Could not load the currency position just now.</Text>
      </Card>
    );
  }

  if (!isLoading && rows.length === 0) {
    return (
      <Card size="small" title="Currency exposure">
        <Empty image={null} description={<Text type="secondary">Nothing outstanding.</Text>} />
      </Card>
    );
  }

  return (
    <Card
      size="small"
      title="Currency exposure"
      loading={isLoading}
      extra={
        data && data.hasForeignExposure ? (
          <Tooltip title="What the rupee value of the outstanding money has done since each order was booked. Unrealised until it is collected.">
            <Space size={6}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                net
              </Text>
              <GainLoss value={data.netForexGainLoss} compact />
            </Space>
          </Tooltip>
        ) : null
      }
    >
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        {!compact && data && (
          <Space size={28} wrap>
            <Statistic title="Outstanding (at booked rates)" value={num(data.totalInrAtSnapshot)} prefix="₹" valueStyle={{ fontSize: 18 }} />
            <Statistic title="At today's rates" value={num(data.totalInrAtCurrent)} prefix="₹" valueStyle={{ fontSize: 18 }} />
          </Space>
        )}

        <Table<ForexCurrencyRow>
          rowKey="currency"
          size="small"
          pagination={false}
          dataSource={rows}
          columns={[
            {
              title: 'Currency',
              dataIndex: 'currency',
              width: 110,
              render: (v: string, r) => (
                <Space size={4}>
                  <Tag color={v === 'INR' ? 'default' : 'blue'} style={{ marginInlineEnd: 0 }}>
                    {v}
                  </Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {r.orderCount} order{r.orderCount === 1 ? '' : 's'}
                  </Text>
                </Space>
              ),
            },
            {
              title: 'Outstanding',
              dataIndex: 'totalFcy',
              align: 'right' as const,
              width: 130,
              render: (v: number, r) => <b style={{ whiteSpace: 'nowrap' }}>{money(v, r.symbol || r.currency)}</b>,
            },
            {
              title: 'Rate booked / now',
              key: 'rate',
              width: 150,
              align: 'right' as const,
              render: (_: unknown, r) =>
                r.currency === 'INR' ? (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    —
                  </Text>
                ) : (
                  <Text style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                    {r.averageSnapshotRate} → <b>{r.currentRate}</b>
                  </Text>
                ),
            },
            { title: 'In ₹ (booked)', dataIndex: 'totalInrAtSnapshot', align: 'right' as const, width: 130, render: (v: number) => <span style={{ whiteSpace: 'nowrap' }}>{money(v, '₹')}</span> },
            { title: 'In ₹ (today)', dataIndex: 'totalInrAtCurrent', align: 'right' as const, width: 130, render: (v: number) => <span style={{ whiteSpace: 'nowrap' }}>{money(v, '₹')}</span> },
            { title: 'Movement', dataIndex: 'forexGainLoss', align: 'right' as const, width: 130, render: (v: number) => <GainLoss value={v} compact /> },
          ]}
        />

        <Text type="secondary" style={{ fontSize: 12 }}>
          Each order is converted at the rate snapshotted when it was created. The movement is unrealised — it becomes real only when the money is received. Update rates in Master Data →
          Currencies.
        </Text>
      </Space>
    </Card>
  );
}
