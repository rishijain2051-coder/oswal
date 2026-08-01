import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Checkbox, DatePicker, Divider, Drawer, Input, InputNumber, Select, Space, Tag, Typography, Upload } from 'antd';
import { PictureOutlined } from '@ant-design/icons';
import type { UploadFile } from 'antd/es/upload/interface';
import { useAuth } from '../../../auth/AuthContext';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api, apiError } from '../../../api/client';
import { MOVE_COLOR, MOVE_LABEL, OPS_KEYS, uploadMovePhotos, type Order, type OrderLineDto } from '../../../api/ops';
import { useWorkers } from '../../../api/manforce';
import { attributionState, availableAt, describe, deriveKind, hopsBetween, keyOf, labelOf, parseKey, suggestedTarget, targetsFor, validate, validateWorkers, type Endpoint } from './moveLogic';

const { Text } = Typography;

export interface MoveTarget {
  line: OrderLineDto;
  from: Endpoint;
}

/**
 * One hand-over of pieces. You choose only where they are and where they are going;
 * the action (cleared / sent back / finished) is derived, so an illegal move cannot
 * be expressed. Crossing several stages at once records a hop per stage, keeping
 * each stage's count — and its jobwork — exact.
 */
export default function MoveDrawer({ order, target, onClose }: { order: Order; target: MoveTarget | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { message } = App.useApp();

  const [toKey, setToKey] = useState<string>();
  const [qty, setQty] = useState(1);
  const [comment, setComment] = useState('');
  /** Rework the vendor or worker spoiled themselves — recorded, but it earns nothing. */
  const [unpaidRework, setUnpaidRework] = useState(false);
  const [date, setDate] = useState<dayjs.Dayjs>(dayjs());
  const [files, setFiles] = useState<UploadFile[]>([]);
  /** Who did the work. Optional — leave it empty and nothing is attributed. */
  const [crew, setCrew] = useState<{ workerId?: number; pieces?: number }[]>([]);
  const { data: workers } = useWorkers({ active: '1' });
  const namedCrew = useMemo(() => crew.filter((c) => c.workerId != null && (c.pieces ?? 0) > 0) as { workerId: number; pieces: number }[], [crew]);

  const board = target?.line.board;
  const from = target?.from ?? null;
  const fromKey = from ? keyOf(from) : undefined;
  const to = useMemo(() => (board ? parseKey(toKey, board.stages) : null), [toKey, board]);

  useEffect(() => {
    if (!target || !board) return;
    setToKey(keyOf(suggestedTarget(board, target.from)));
    setQty(Math.max(availableAt(board, target.from), 1));
    setComment('');
    setDate(dayjs());
    setFiles([]);
    setCrew([]);
  }, [target?.line.id, fromKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const attribution = useMemo(() => (board ? attributionState(board, from, to) : { allowed: false, stage: null, reason: undefined }), [board, from, to]);

  // Changing the target can make attribution impossible — a clearance across several
  // stages cannot say who did which — so drop the crew rather than send it anyway.
  useEffect(() => {
    if (!attribution.allowed && crew.length) setCrew([]);
  }, [attribution.allowed]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Only a clearance earns, and only somebody who sets rates may decide it earns nothing. */
  const { can } = useAuth();
  const canSetRates = can('board.rates');
  const isClearance = !!from && from.kind === 'STAGE' && (!to || to.kind !== 'STAGE' || to.stage.sortOrder > from.stage.sortOrder);

  const invalidate = () => {
    for (const key of OPS_KEYS) qc.invalidateQueries({ queryKey: key });
  };

  const post = useMutation({
    mutationFn: async () => {
      const res = await api.post<Order>(`/orders/${order.id}/moves`, {
        moves: [
          {
            orderLineId: target!.line.id,
            kind: deriveKind(from!, to!),
            fromStageId: from!.kind === 'STAGE' ? from!.stage.id : null,
            toStageId: to!.kind === 'STAGE' ? to!.stage.id : null,
            qty,
            workers: namedCrew.length ? namedCrew : undefined,
            // Omitted unless ticked: the server treats absence as ordinary, paid work, and
            // sending it always would need the rates permission for every movement.
            billable: unpaidRework ? false : undefined,
          },
        ],
        date: date.toISOString(),
        comment: comment.trim() || null,
      });
      const picked = files.map((f) => f.originFileObj).filter(Boolean) as File[];
      if (picked.length && res.data.photoMoveId) await uploadMovePhotos(res.data.photoMoveId, picked);
      return res.data;
    },
    onSuccess: (data) => {
      const bits = [describe(from!, to!, qty)];
      if ((data.createdMoves ?? 1) > 1) bits.push(`${data.createdMoves} stage hops recorded.`);
      if (files.length) bits.push(`${files.length} photo(s) attached.`);
      if (data.statusChangedTo) bits.push(`Order is now ${data.statusChangedTo}.`);
      message.success(bits.join(' '));
      invalidate();
      onClose();
    },
    onError: (e) => message.error(apiError(e)),
  });

  if (!target || !board) return <Drawer open={false} onClose={onClose} />;

  const crewError = attribution.allowed ? validateWorkers(qty, crew, attribution.stage) : null;
  const crewPieces = namedCrew.reduce((a, c) => a + c.pieces, 0);
  const error = validate(board, from, to, qty) ?? crewError;
  const kind = from && to ? deriveKind(from, to) : null;
  const available = availableAt(board, target.from);
  const hops = from && to ? hopsBetween(board, from, to) : [];
  const crossing = hops.filter((s) => s.vendorId);
  /** Finishing from anywhere but the last stage jumps over the rest of the line. */
  const skipped =
    kind === 'COMPLETE' && from?.kind === 'STAGE' ? board.stages.filter((s) => s.sortOrder > from.stage.sortOrder) : [];

  return (
    <Drawer
      open
      width={520}
      onClose={onClose}
      title={
        <Space direction="vertical" size={0}>
          <span>Pass pieces on</span>
          <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
            {target.line.product.factoryCode} — {target.line.product.name}
          </Text>
        </Space>
      }
      footer={
        <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="primary" loading={post.isPending} disabled={!!error} onClick={() => post.mutate()}>
            {kind ? MOVE_LABEL[kind] : 'Record'} {qty} pc{qty === 1 ? '' : 's'}
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <div>
          <Text type="secondary">From</Text>
          <div>
            <Tag color="#6d4c41" style={{ fontSize: 14, padding: '4px 10px' }}>
              {labelOf(target.from)}
            </Tag>
            <Text type="secondary">{available} pc(s) here</Text>
          </div>
        </div>

        <div>
          <Text type="secondary">Pass to *</Text>
          <Select
            style={{ width: '100%' }}
            value={toKey}
            onChange={setToKey}
            options={targetsFor(board, from).map((t) => ({
              value: t.value,
              label: (
                <span>
                  {t.label}
                  {t.hint && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {' '}
                      · {t.hint}
                    </Text>
                  )}
                </span>
              ),
            }))}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            Pick any stage ahead — several stages at once is fine.
          </Text>
        </div>

        <div>
          <Text type="secondary">Pieces *</Text>
          <Space.Compact style={{ width: '100%' }}>
            <InputNumber min={1} max={Math.max(available, 1)} value={qty} onChange={(v) => setQty(v ?? 1)} style={{ width: '100%' }} />
            <Button onClick={() => setQty(available)} disabled={available < 1}>
              All {available}
            </Button>
          </Space.Compact>
        </div>

        {error ? (
          <Alert type="error" showIcon message={error} />
        ) : (
          <Alert
            type={kind === 'REJECT' ? 'warning' : 'info'}
            showIcon
            message={
              <span>
                <Tag color={MOVE_COLOR[kind!]}>{MOVE_LABEL[kind!]}</Tag>
                {describe(from!, to!, qty)}
              </span>
            }
            description={
              hops.length > 1 ? (
                <span>
                  Recorded as {hops.length} steps: {hops.map((s) => s.name).join(' → ')}.
                  {crossing.length > 0 && ` Jobwork counts for ${crossing.map((s) => s.vendor?.name ?? 'vendor').join(', ')}.`}
                </span>
              ) : skipped.length > 0 ? (
                <span>
                  Skips {skipped.map((s) => s.name).join(', ')} — nobody is credited for those stages
                  {skipped.some((s) => s.vendorId) ? `, including ${[...new Set(skipped.filter((s) => s.vendorId).map((s) => s.vendor?.name ?? 'a vendor'))].join(' and ')}` : ''}. Advance
                  through them first if that work was really done.
                </span>
              ) : undefined
            }
          />
        )}

        <div>
          <Text type="secondary">Date</Text>
          <DatePicker style={{ width: '100%' }} value={date} onChange={(d) => setDate(d ?? dayjs())} allowClear={false} />
        </div>

        <Divider style={{ margin: '4px 0' }} />

        <div>
          <Text strong>Hand-over note</Text>
          <Input.TextArea
            rows={3}
            placeholder="What is being passed on, in what condition, anything the next stage should know…"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </div>

        {canSetRates && isClearance && (
          <div>
            <Checkbox checked={unpaidRework} onChange={(e) => setUnpaidRework(e.target.checked)}>
              This is rework at their own cost — do not pay for it
            </Checkbox>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginLeft: 24 }}>
              The movement is recorded either way, so the board still shows the pieces going
              through. Only the earning is withheld — for when the vendor or the worker is
              putting right something they spoiled.
            </Text>
          </div>
        )}

        <div>
          <Text strong>Who did the work</Text>
          {attribution.allowed ? (
            <>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
                Optional. Name them and the pieces each did — it must add up to {qty} — and they earn ₹{attribution.stage?.labourRate ?? 0} a piece for {attribution.stage?.name}.
              </Text>
              {crew.map((c, i) => (
                <Space.Compact key={i} style={{ width: '100%', marginBottom: 6 }}>
                  <Select
                    style={{ width: '100%' }}
                    placeholder="Worker"
                    showSearch
                    optionFilterProp="label"
                    value={c.workerId}
                    onChange={(v) => setCrew((list) => list.map((x, j) => (j === i ? { ...x, workerId: v } : x)))}
                    options={(workers ?? []).map((w) => ({ value: w.id, label: `${w.code} · ${w.name}${w.contractor ? ` (${w.contractor.name})` : ''}` }))}
                  />
                  <InputNumber
                    min={1}
                    max={qty}
                    placeholder="pc"
                    style={{ width: 110 }}
                    value={c.pieces}
                    onChange={(v) => setCrew((list) => list.map((x, j) => (j === i ? { ...x, pieces: v ?? undefined } : x)))}
                  />
                  <Button danger onClick={() => setCrew((list) => list.filter((_, j) => j !== i))}>
                    ✕
                  </Button>
                </Space.Compact>
              ))}
              <Space>
                <Button
                  size="small"
                  onClick={() => setCrew((list) => [...list, { workerId: undefined, pieces: Math.max(qty - crewPieces, 1) }])}
                  disabled={!(attribution.stage?.labourRate ?? 0) && crew.length > 0}
                >
                  + add a worker
                </Button>
                {crew.length > 0 && (
                  <Text type={crewPieces === qty ? 'success' : 'warning'} style={{ fontSize: 12 }}>
                    {crewPieces} of {qty} pc accounted for
                  </Text>
                )}
              </Space>
              {!(attribution.stage?.labourRate ?? 0) && (
                <Alert
                  style={{ marginTop: 8 }}
                  type="info"
                  showIcon
                  message="This stage has no piece rate"
                  description="Workers on it are paid by the day, so there is nothing to attribute. Set a labour rate on the stage first if this is piece work."
                />
              )}
            </>
          ) : (
            <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
              {attribution.reason ?? 'Pick where the pieces are going first.'}
            </Text>
          )}
        </div>

        <div>
          <Text strong>Photos</Text>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
            Proof of condition at the hand-over. Kept against this movement.
          </Text>
          <Upload
            listType="picture-card"
            multiple
            accept="image/*"
            fileList={files}
            beforeUpload={() => false}
            onChange={({ fileList }) => setFiles(fileList.slice(0, 10))}
          >
            {files.length < 10 && (
              <div>
                <PictureOutlined />
                <div style={{ marginTop: 6, fontSize: 12 }}>Add</div>
              </div>
            )}
          </Upload>
        </div>
      </Space>
    </Drawer>
  );
}
