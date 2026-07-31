import { Fragment } from 'react';
import { App, Button, Popconfirm, Space, Tag, Tooltip, Typography } from 'antd';
import { CheckOutlined, ShopOutlined, HomeOutlined, WarningOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, apiError } from '../../../api/client';
import { OPS_KEYS, type LineBoard, type Order, type OrderLineDto, type StageCell } from '../../../api/ops';
import { DONE, PENDING, deriveKind, labelOf, suggestedTarget, type Endpoint } from './moveLogic';
import type { MoveTarget } from './MoveDrawer';

const { Text } = Typography;

/**
 * The whole state of one order line in one glance: how many pieces sit in the
 * not-started pool, at each stage, and in the finished pool. Click any bucket that
 * holds pieces to move them; the tick button clears the lot forward in one go.
 */
export default function StageStrip({ order, line, editable, onMove }: { order: Order; line: OrderLineDto; editable: boolean; onMove: (t: MoveTarget) => void }) {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const board = line.board;

  const quickClear = useMutation({
    mutationFn: ({ from, to, qty }: { from: Endpoint; to: Endpoint; qty: number }) =>
      api.post(`/orders/${order.id}/moves`, {
        moves: [
          {
            orderLineId: line.id,
            kind: deriveKind(from, to),
            fromStageId: from.kind === 'STAGE' ? from.stage.id : null,
            toStageId: to.kind === 'STAGE' ? to.stage.id : null,
            qty,
          },
        ],
      }),
    onSuccess: (res) => {
      const data = res.data as Order;
      message.success(data.statusChangedTo ? `Passed on. Order is now ${data.statusChangedTo}.` : 'Passed on.');
      for (const key of OPS_KEYS) qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => message.error(apiError(e)),
  });

  const bucket = (e: Endpoint, count: number, opts: { tone: 'pending' | 'stage' | 'done'; stage?: StageCell }) => {
    const { tone, stage } = opts;
    const filled = count > 0;
    const target = suggestedTarget(board, e);
    const canQuick = editable && filled && !!deriveKind(e, target);

    return (
      <div key={labelOf(e) + (stage?.id ?? tone)} className={`board-cell board-cell-${tone}${filled ? ' is-filled' : ''}${editable && filled ? ' is-clickable' : ''}`} onClick={() => editable && filled && onMove({ line, from: e })}>
        <div className="board-cell-head">
          {stage ? <span className="board-cell-num">{stage.sortOrder + 1}</span> : null}
          <span className="board-cell-name">{labelOf(e)}</span>
        </div>
        <div className="board-cell-qty">{count}</div>
        <div className="board-cell-foot">
          {stage?.vendor ? (
            <Tooltip title={`Jobwork: ${stage.vendor.name}${stage.jobworkRate ? ` · ₹${stage.jobworkRate}/pc` : ''}`}>
              <Tag color="volcano" icon={<ShopOutlined />} style={{ margin: 0, maxWidth: 118, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {stage.vendor.name}
              </Tag>
            </Tooltip>
          ) : stage ? (
            <Tooltip title={stage.labourRate ? `In-house piece work · ₹${stage.labourRate}/pc to whoever clears it` : 'In-house · day-wage work, no piece rate'}>
              <Tag icon={<HomeOutlined />} style={{ margin: 0 }}>
                {stage.labourRate ? `₹${stage.labourRate}/pc` : 'In-house'}
              </Tag>
            </Tooltip>
          ) : null}
          {stage && stage.rejectedIn > 0 && (
            <Tooltip title={`${stage.rejectedIn} pc(s) have come back here after a rejection`}>
              <Tag color="red" icon={<WarningOutlined />} style={{ margin: 0 }}>
                {stage.rejectedIn} back
              </Tag>
            </Tooltip>
          )}
          {stage && stage.cleared > 0 && stage.at === 0 && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {stage.cleared} passed
            </Text>
          )}
        </div>
        {canQuick && (
          <div className="board-cell-actions" onClick={(ev) => ev.stopPropagation()}>
            <Popconfirm
              title={`Pass all ${count} pc(s) on?`}
              description={`${labelOf(e)} → ${labelOf(target)}, with no note or photos. Click the bucket instead to add them.`}
              okText="Pass on"
              onConfirm={() => quickClear.mutate({ from: e, to: target, qty: count })}
            >
              <Tooltip title={`Pass all ${count} → ${labelOf(target)}`}>
                <Button
                  size="small"
                  type="text"
                  aria-label={`Pass all ${count} pieces on to ${labelOf(target)}`}
                  icon={<CheckOutlined />}
                  loading={quickClear.isPending}
                />
              </Tooltip>
            </Popconfirm>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="board-strip">
      {bucket(PENDING, board.pending, { tone: 'pending' })}
      {board.stages.map((s) => (
        <Fragment key={s.id}>
          <span className="board-arrow">›</span>
          {bucket({ kind: 'STAGE', stage: s }, s.at, { tone: 'stage', stage: s })}
        </Fragment>
      ))}
      <span className="board-arrow">›</span>
      {bucket(DONE, board.done, { tone: 'done' })}
    </div>
  );
}

/** Compact one-line version used on the orders list. */
export function MiniStrip({ board }: { board: LineBoard }) {
  const cells: { label: string; count: number; tone: string }[] = [
    { label: 'Not started', count: board.pending, tone: 'pending' },
    ...board.stages.map((s) => ({ label: s.name, count: s.at, tone: 'stage' })),
    { label: 'Finished', count: board.done, tone: 'done' },
  ];
  return (
    <Space size={4} wrap>
      {cells
        .filter((c) => c.count > 0)
        .map((c) => (
          <Tooltip key={c.label} title={c.label}>
            <Tag color={c.tone === 'done' ? 'green' : c.tone === 'pending' ? 'default' : 'gold'} style={{ margin: 0 }}>
              {c.count} {c.label}
            </Tag>
          </Tooltip>
        ))}
    </Space>
  );
}
