import { useMemo, useState } from 'react';
import { Breadcrumb, Card, Col, Empty, Progress, Row, Segmented, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { HomeOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api } from '../../api/client';
import { useBuyers } from '../../api/hooks';
import { DELIVERY_COLOUR, DELIVERY_TEXT, type DeliveryRow, type DeliveryStatusResponse } from '../../api/ops';

const { Title, Text } = Typography;

const FILTERS = ['Needs attention', 'All', 'Late', 'At risk', 'On track', 'Delivered'] as const;

/**
 * Which orders are going to make their date, most urgent first.
 *
 * Every figure is derived — progress from the board, the verdict from that plus today —
 * so this page is never out of step with the boards it summarises.
 */
export default function DeliveryTracker() {
  const navigate = useNavigate();
  const { data: buyers } = useBuyers();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('Needs attention');
  const [buyerId, setBuyerId] = useState<number>();

  const { data, isLoading } = useQuery<DeliveryStatusResponse>({
    queryKey: ['delivery-status'],
    queryFn: async () => (await api.get('/orders/delivery-status')).data,
  });

  const rows = useMemo(() => {
    let list = data?.rows ?? [];
    if (buyerId) list = list.filter((r) => r.buyerId === buyerId);
    if (filter === 'Needs attention') list = list.filter((r) => r.deliveryStatus === 'LATE' || r.deliveryStatus === 'AT_RISK');
    else if (filter === 'Late') list = list.filter((r) => r.deliveryStatus === 'LATE');
    else if (filter === 'At risk') list = list.filter((r) => r.deliveryStatus === 'AT_RISK');
    else if (filter === 'On track') list = list.filter((r) => r.deliveryStatus === 'ON_TRACK');
    else if (filter === 'Delivered') list = list.filter((r) => r.deliveryStatus === 'DELIVERED');
    return list;
  }, [data, filter, buyerId]);

  // Counted from the FILTERED list, not the server's factory-wide figure — otherwise
  // picking a buyer with one late order showed "Late 7" above a single row.
  const counts = useMemo(() => {
    const base = (data?.rows ?? []).filter((r) => !buyerId || r.buyerId === buyerId);
    const out: Record<string, number> = { LATE: 0, AT_RISK: 0, ON_TRACK: 0, NO_DATE: 0, DELIVERED: 0 };
    for (const r of base) out[r.deliveryStatus] = (out[r.deliveryStatus] ?? 0) + 1;
    return out;
  }, [data, buyerId]);
  const cards: { key: string; label: string; n: number; colour: string }[] = [
    { key: 'LATE', label: 'Late', n: counts.LATE ?? 0, colour: '#c62828' },
    { key: 'AT_RISK', label: 'At risk', n: counts.AT_RISK ?? 0, colour: '#ef6c00' },
    { key: 'ON_TRACK', label: 'On track', n: counts.ON_TRACK ?? 0, colour: '#2e7d32' },
    { key: 'DELIVERED', label: 'Delivered', n: counts.DELIVERED ?? 0, colour: '#607d8b' },
  ];

  return (
    <div>
      <Breadcrumb
        style={{ marginBottom: 16 }}
        items={[{ title: <Link to="/"><HomeOutlined /></Link> }, { title: <Link to="/operations">Operations</Link> }, { title: 'Delivery' }]}
      />
      <div style={{ marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>
          Delivery
        </Title>
        <Text type="secondary">Which orders will make their date. Progress comes straight off each production board.</Text>
      </div>

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        {cards.map((c) => (
          <Col xs={12} md={6} key={c.key}>
            <Card size="small" hoverable onClick={() => setFilter(c.key === 'LATE' ? 'Late' : c.key === 'AT_RISK' ? 'At risk' : c.key === 'ON_TRACK' ? 'On track' : 'Delivered')}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {c.label}
              </Text>
              <div style={{ fontSize: 26, fontWeight: 700, color: c.colour, lineHeight: 1.2 }}>{c.n}</div>
            </Card>
          </Col>
        ))}
      </Row>

      <Card size="small">
        <Space wrap style={{ marginBottom: 12 }}>
          <Segmented value={filter} onChange={(v) => setFilter(v as (typeof FILTERS)[number])} options={FILTERS as unknown as string[]} />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="Any buyer"
            style={{ width: 220 }}
            value={buyerId}
            onChange={setBuyerId}
            options={(buyers ?? []).map((b) => ({ label: `${b.code} · ${b.name}`, value: b.id }))}
          />
        </Space>

        {rows.length === 0 && !isLoading ? (
          <Empty description={filter === 'Needs attention' ? 'Nothing late or at risk. ' : 'No orders here.'} />
        ) : (
          <Table<DeliveryRow>
            rowKey="orderId"
            size="small"
            loading={isLoading}
            dataSource={rows}
            pagination={{ pageSize: 20, hideOnSinglePage: true }}
            onRow={(r) => ({ onClick: () => navigate(`/operations/orders/${r.orderId}`), style: { cursor: 'pointer' } })}
            columns={[
              { title: 'Order', dataIndex: 'number', width: 150, render: (v: string) => <b>{v}</b> },
              {
                title: 'Buyer',
                dataIndex: 'buyerName',
                render: (v: string, r) => (
                  <span>
                    {v}
                    <br />
                    <Tag color={r.market === 'DOMESTIC' ? 'geekblue' : 'gold'} style={{ marginTop: 2 }}>
                      {r.market === 'DOMESTIC' ? 'Domestic' : 'Overseas'}
                    </Tag>
                  </span>
                ),
              },
              {
                title: 'Delivery',
                dataIndex: 'deliveryStatus',
                width: 150,
                render: (v: string, r) => (
                  <Tooltip title={r.reason}>
                    <Tag color={DELIVERY_COLOUR[v] ?? 'default'}>{DELIVERY_TEXT[v] ?? v}</Tag>
                  </Tooltip>
                ),
              },
              {
                title: 'Progress',
                dataIndex: 'percentComplete',
                width: 170,
                render: (v: number, r) => (
                  <Space direction="vertical" size={0} style={{ width: 150 }}>
                    <Progress percent={v} size="small" status={r.deliveryStatus === 'LATE' ? 'exception' : v >= 100 ? 'success' : 'active'} />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {r.done} of {r.qty} pc done{r.wip > 0 ? `, ${r.wip} moving` : ''}
                    </Text>
                  </Space>
                ),
              },
              {
                title: 'Due',
                dataIndex: 'deliveryDate',
                width: 150,
                render: (v: string | null, r) =>
                  v ? (
                    <Space direction="vertical" size={0}>
                      <Text>{dayjs(v).format('DD MMM YYYY')}</Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {r.daysLate > 0 ? `${r.daysLate} day(s) late` : r.daysToDelivery != null ? `${r.daysToDelivery} day(s) to go` : ''}
                      </Text>
                    </Space>
                  ) : (
                    <Text type="secondary">—</Text>
                  ),
              },
              {
                title: 'Expected',
                dataIndex: 'expectedDelivery',
                width: 120,
                render: (v: string | null) => (v ? <Text type="secondary">{dayjs(v).format('DD MMM YYYY')}</Text> : <Text type="secondary">—</Text>),
              },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
