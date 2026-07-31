import { useEffect, useState } from 'react';
import { Alert, App, Button, DatePicker, Drawer, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { ThunderboltOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api, apiError } from '../../../api/client';
import { OPS_KEYS, STAGE_STATUS_COLOUR, useOrder, type Order, type OrderLineDto } from '../../../api/ops';

const { Text } = Typography;

interface Row {
  orderLineStageId: number;
  name: string;
  sortOrder: number;
  at: number;
  cleared: number;
  start: dayjs.Dayjs | null;
  end: dayjs.Dayjs | null;
  status: string;
  daysOverdue: number;
}

/**
 * When each stage of one line should happen, next to where the pieces actually are.
 *
 * The bar chart is deliberately the derived half: the dates are editable, the progress
 * bar behind them is read-only and comes off the board. Nothing here can move a piece.
 */
export default function ScheduleDrawer({ order, line, onClose }: { order: Order; line: OrderLineDto | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [rows, setRows] = useState<Row[]>([]);

  // `line` is a snapshot captured when the drawer opened, so auto-scheduling would write
  // a schedule the form never saw — leaving every picker blank, and then Save would post
  // all-nulls and wipe what was just generated. Re-read the order live and take the line
  // from that.
  const { data: fresh } = useOrder(String(order.id));
  const current = (fresh?.lines.find((l) => l.id === line?.id) ?? line) as OrderLineDto | null;

  useEffect(() => {
    if (!current) return;
    setRows(
      current.board.stages.map((s) => {
        const planned = current.schedule?.stages.find((x) => x.orderLineStageId === s.id);
        return {
          orderLineStageId: s.id,
          name: s.name,
          sortOrder: s.sortOrder,
          at: s.at,
          cleared: s.cleared,
          start: planned?.estimatedStart ? dayjs(planned.estimatedStart) : null,
          end: planned?.estimatedEnd ? dayjs(planned.estimatedEnd) : null,
          status: planned?.status ?? 'NOT_STARTED',
          daysOverdue: planned?.daysOverdue ?? 0,
        };
      })
    );
  }, [current?.id, current?.schedule]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => {
    for (const k of OPS_KEYS) qc.invalidateQueries({ queryKey: k });
    qc.invalidateQueries({ queryKey: ['delivery-status'] });
  };

  const save = useMutation({
    mutationFn: () =>
      api.put(`/orders/${order.id}/schedule`, {
        lines: [
          {
            orderLineId: current!.id,
            estimatedDone: rows.length ? rows[rows.length - 1].end?.toISOString() ?? null : null,
            stages: rows.map((r) => ({ orderLineStageId: r.orderLineStageId, estimatedStart: r.start?.toISOString() ?? null, estimatedEnd: r.end?.toISOString() ?? null })),
          },
        ],
      }),
    onSuccess: () => {
      message.success('Schedule saved.');
      refresh();
      onClose();
    },
    onError: (e) => message.error(apiError(e)),
  });

  const auto = useMutation({
    mutationFn: () => api.post(`/orders/${order.id}/auto-schedule`, {}),
    onSuccess: () => {
      // Order-wide by design on the server, so say so — this drawer names one line and
      // silently rewriting hand-tuned dates on the others would be a nasty surprise.
      message.success(order.lines.length > 1 ? `Filled in all ${order.lines.length} lines from the delivery date and each stage’s usual duration.` : 'Filled in from the delivery date and each stage’s usual duration.');
      refresh();
    },
    onError: (e) => message.error(apiError(e)),
  });

  if (!line || !current) return <Drawer open={false} onClose={onClose} />;

  const set = (id: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.orderLineStageId === id ? { ...r, ...patch } : r)));

  // The window every bar is drawn against.
  const dates = rows.flatMap((r) => [r.start, r.end]).filter((d): d is dayjs.Dayjs => !!d);
  const min = dates.length ? dates.reduce((a, b) => (a.isBefore(b) ? a : b)) : null;
  const max = dates.length ? dates.reduce((a, b) => (a.isAfter(b) ? a : b)) : null;
  const span = min && max ? Math.max(1, max.diff(min, 'day') + 1) : 1;

  const outOfOrder = rows.some((r, i) => i > 0 && r.start && rows[i - 1].end && r.start.isBefore(rows[i - 1].end!, 'day'));

  return (
    <Drawer
      open
      width={860}
      onClose={onClose}
      title={
        <Space direction="vertical" size={0}>
          <span>When should this be done?</span>
          <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
            {current.product.factoryCode} — {current.product.name} · {current.qty} pcs
          </Text>
        </Space>
      }
      footer={
        <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save schedule
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space wrap>
          <Button icon={<ThunderboltOutlined />} loading={auto.isPending} onClick={() => auto.mutate()}>
            Auto-schedule
          </Button>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Works backwards from {order.deliveryDate ? dayjs(order.deliveryDate).format('DD MMM YYYY') : 'the delivery date'} using each stage&rsquo;s usual duration (Master Data → Stage
            Lines).
          </Text>
        </Space>

        {order.lines.length > 1 && (
          <Alert type="info" showIcon message={`Auto-schedule covers all ${order.lines.length} lines on this order`} description="It replaces any dates already set on the other lines. Edit the dates below to change this line only." />
        )}

        {current.schedule?.isBehind && (
          <Alert
            type="warning"
            showIcon
            message={`Behind by ${current.schedule!.daysLate} day(s)`}
            description="A stage is past its planned end and the pieces have not moved on. The dates below are the plan; the bars behind them are what the board actually shows."
          />
        )}
        {outOfOrder && <Alert type="warning" showIcon message="A stage starts before the one before it ends" description="Production runs in order, so overlapping dates will read oddly." />}

        <Table<Row>
          rowKey="orderLineStageId"
          size="small"
          pagination={false}
          dataSource={rows}
          columns={[
            { title: '#', dataIndex: 'sortOrder', width: 36, render: (v: number) => v + 1 },
            { title: 'Stage', dataIndex: 'name', width: 130 },
            {
              title: 'Planned start',
              width: 140,
              render: (_, r) => <DatePicker size="small" style={{ width: 130 }} format="DD MMM YY" value={r.start} onChange={(d) => set(r.orderLineStageId, { start: d })} />,
            },
            {
              title: 'Planned end',
              width: 140,
              render: (_, r) => <DatePicker size="small" style={{ width: 130 }} format="DD MMM YY" value={r.end} onChange={(d) => set(r.orderLineStageId, { end: d })} />,
            },
            {
              title: 'Plan vs actual',
              key: 'bar',
              render: (_, r) => {
                if (!r.start || !r.end || !min) return <Text type="secondary" style={{ fontSize: 12 }}>not scheduled</Text>;
                const offset = (r.start.diff(min, 'day') / span) * 100;
                const width = Math.max(3, ((r.end.diff(r.start, 'day') + 1) / span) * 100);
                return (
                  <Tooltip title={`${r.name}: ${r.start.format('DD MMM')} – ${r.end.format('DD MMM')} · ${r.status.replace('_', ' ').toLowerCase()}${r.daysOverdue ? `, ${r.daysOverdue} day(s) over` : ''}`}>
                    <div style={{ position: 'relative', height: 16, background: '#fafafa', borderRadius: 3 }}>
                      <div
                        style={{
                          position: 'absolute',
                          left: `${offset}%`,
                          width: `${width}%`,
                          top: 3,
                          height: 10,
                          borderRadius: 3,
                          background: STAGE_STATUS_COLOUR[r.status] ?? '#e0e0e0',
                        }}
                      />
                    </div>
                  </Tooltip>
                );
              },
            },
            {
              title: 'Board',
              width: 150,
              render: (_, r) => (
                <Space size={4}>
                  <Tag color={STAGE_STATUS_COLOUR[r.status] ? undefined : 'default'} style={{ margin: 0 }}>
                    {r.status.replace('_', ' ').toLowerCase()}
                  </Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {r.at > 0 ? `${r.at} here` : r.cleared > 0 ? `${r.cleared} passed` : '—'}
                  </Text>
                </Space>
              ),
            },
          ]}
        />

        <Text type="secondary" style={{ fontSize: 12 }}>
          This is a plan laid over the board, not part of it. Where the pieces are stays derived from the movement ledger — nothing here can move one.
        </Text>
      </Space>
    </Drawer>
  );
}
