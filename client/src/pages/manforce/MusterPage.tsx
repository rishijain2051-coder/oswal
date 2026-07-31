import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Breadcrumb, Button, Card, DatePicker, Empty, Input, InputNumber, Segmented, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { HomeOutlined, SaveOutlined, ReloadOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import { api, apiError } from '../../api/client';
import { ATTENDANCE_COLOR, ATTENDANCE_LABEL, ATTENDANCE_STATUSES, MANFORCE_KEYS, useMuster, type AttendanceStatus, type MusterWorker } from '../../api/manforce';
import { useAuth } from '../../auth/AuthContext';
import { num } from '../../util/format';

const { Title, Text } = Typography;

interface Mark {
  status: AttendanceStatus | null;
  otHours: number;
  note: string;
}

/** The statuses offered as one-click buttons, in the order a supervisor thinks. */
const QUICK: (AttendanceStatus | null)[] = [null, 'ABSENT', 'HALF_DAY', 'LEAVE', 'PAID_LEAVE', 'PRESENT'];

/**
 * The muster roll.
 *
 * Attendance is EXCEPTIONS-ONLY: everyone active is presumed present on a working day,
 * so an untouched screen is already a full day's attendance. You mark who was away.
 * "Presumed" is therefore the resting state, not a missing value.
 */
export default function MusterPage() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { hasRole } = useAuth();
  const canEdit = hasRole('Operator');

  const [date, setDate] = useState<Dayjs>(dayjs());
  const [q, setQ] = useState('');
  const [marks, setMarks] = useState<Record<number, Mark>>({});

  const key = date.format('YYYY-MM-DD');
  const { data, isLoading } = useMuster(key);

  // Start from what is recorded, so an edit is a change to the real state.
  useEffect(() => {
    if (!data) return;
    const next: Record<number, Mark> = {};
    for (const w of data.workers) next[w.workerId] = { status: w.status, otHours: w.otHours, note: w.note ?? '' };
    setMarks(next);
  }, [data]);

  const dirty = useMemo(() => {
    if (!data) return [];
    return data.workers.filter((w) => {
      const m = marks[w.workerId];
      if (!m) return false;
      return m.status !== w.status || m.otHours !== w.otHours || (m.note || '') !== (w.note ?? '');
    });
  }, [data, marks]);

  const save = useMutation({
    mutationFn: () =>
      api.post('/attendance', {
        date: date.startOf('day').toISOString(),
        marks: dirty.map((w) => ({ workerId: w.workerId, status: marks[w.workerId].status, otHours: marks[w.workerId].otHours || 0, note: marks[w.workerId].note || null })),
      }),
    onSuccess: () => {
      message.success(`Saved ${dirty.length} change(s).`);
      for (const k of MANFORCE_KEYS) qc.invalidateQueries({ queryKey: k });
    },
    onError: (e) => message.error(apiError(e)),
  });

  const set = (workerId: number, patch: Partial<Mark>) => setMarks((m) => ({ ...m, [workerId]: { ...m[workerId], ...patch } }));

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return data?.workers ?? [];
    return (data?.workers ?? []).filter((w) => [w.name, w.code, w.trade, w.contractor].some((v) => v?.toLowerCase().includes(needle)));
  }, [data, q]);

  const counts = useMemo(() => {
    const list = data?.workers ?? [];
    const away = list.filter((w) => marks[w.workerId]?.status === 'ABSENT' || marks[w.workerId]?.status === 'LEAVE').length;
    const half = list.filter((w) => marks[w.workerId]?.status === 'HALF_DAY').length;
    const ot = list.reduce((a, w) => a + (marks[w.workerId]?.otHours ?? 0), 0);
    return { total: list.length, away, half, ot, present: list.length - away - half };
  }, [data, marks]);

  const isFuture = date.startOf('day').isAfter(dayjs().startOf('day'));

  return (
    <div>
      <Breadcrumb style={{ marginBottom: 16 }} items={[{ title: <Link to="/"><HomeOutlined /></Link> }, { title: <Link to="/manforce">Manforce</Link> }, { title: 'Muster roll' }]} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <Title level={2} style={{ marginBottom: 2 }}>
            Muster roll
          </Title>
          <Text type="secondary">Everyone is presumed present. Mark only who was away, and any overtime.</Text>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => qc.invalidateQueries({ queryKey: ['muster', key] })}>
            Reload
          </Button>
          {canEdit && (
            <Button type="primary" icon={<SaveOutlined />} disabled={dirty.length === 0} loading={save.isPending} onClick={() => save.mutate()}>
              Save {dirty.length || ''} change{dirty.length === 1 ? '' : 's'}
            </Button>
          )}
        </Space>
      </div>

      <Card size="small" style={{ margin: '16px 0' }}>
        <Space wrap size="large">
          <Space>
            <Button size="small" onClick={() => setDate(date.subtract(1, 'day'))}>
              ‹ previous
            </Button>
            <DatePicker
              id="muster-date"
              name="muster-date"
              value={date}
              onChange={(d) => d && setDate(d)}
              format="ddd DD MMM YYYY"
              allowClear={false}
              disabledDate={(d) => d.isAfter(dayjs(), 'day')}
            />
            <Button size="small" disabled={date.isSame(dayjs(), 'day')} onClick={() => setDate(date.add(1, 'day'))}>
              next ›
            </Button>
            <Button size="small" disabled={date.isSame(dayjs(), 'day')} onClick={() => setDate(dayjs())}>
              today
            </Button>
          </Space>
          {/* id/name so the browser can identify the field; autoComplete off because a
              filter term is not data worth remembering. */}
          <Input id="muster-search" name="muster-search" autoComplete="off" allowClear placeholder="Find a worker…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
          <Text type="secondary">
            {counts.present} present · {counts.away} away · {counts.half} half day{counts.ot ? ` · ${num(counts.ot, 1)} OT h` : ''}
          </Text>
        </Space>
      </Card>

      {data && !data.isWorkingDay && (
        <Alert
          style={{ marginBottom: 16 }}
          type="warning"
          showIcon
          message={data.holiday ? `${data.holiday} — a factory holiday` : 'Weekly off'}
          description="Nothing accrues today. Mark someone present only if they actually came in — that pays them for the day."
        />
      )}
      {data && !data.presumePresent && (
        <Alert
          style={{ marginBottom: 16 }}
          type="info"
          showIcon
          message="Presumption is switched off"
          description="Only workers explicitly marked present earn for the day. Change this in Master Data → Working Days if you'd rather presume attendance."
        />
      )}
      {isFuture && <Alert style={{ marginBottom: 16 }} type="error" showIcon message="That day has not happened yet." />}

      <Table<MusterWorker>
        rowKey="workerId"
        size="small"
        loading={isLoading}
        dataSource={filtered}
        pagination={{ pageSize: 50, showSizeChanger: true }}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nobody was on the books on this date" /> }}
        rowClassName={(w) => (dirty.some((d) => d.workerId === w.workerId) ? 'ant-table-row-selected' : '')}
        columns={[
          {
            title: 'Worker',
            dataIndex: 'name',
            width: 240,
            render: (_, w) => (
              <span>
                <Link to={`/manforce/workers/${w.workerId}`}>{w.name}</Link>
                <br />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {w.code}
                  {w.trade ? ` · ${w.trade}` : ''}
                  {w.contractor ? ` · ${w.contractor}` : ''}
                </Text>
              </span>
            ),
          },
          {
            title: 'Attendance',
            key: 'status',
            width: 430,
            render: (_, w) => {
              const m = marks[w.workerId];
              return (
                <Segmented
                  size="small"
                  disabled={!canEdit || isFuture}
                  value={m?.status ?? 'PRESUMED'}
                  onChange={(v) => set(w.workerId, { status: v === 'PRESUMED' ? null : (v as AttendanceStatus) })}
                  options={QUICK.map((s) =>
                    s === null
                      ? { label: data && !data.isWorkingDay ? 'Off' : data?.presumePresent ? 'Presumed' : 'Not marked', value: 'PRESUMED' }
                      : { label: ATTENDANCE_LABEL[s].replace(' (unpaid)', ''), value: s }
                  )}
                />
              );
            },
          },
          {
            title: (
              <Tooltip title="Paid at the worker's overtime rate, on top of the day. Recorded separately from the day mark.">
                <span>OT hours</span>
              </Tooltip>
            ),
            key: 'ot',
            width: 110,
            render: (_, w) =>
              w.paysByAttendance ? (
                <InputNumber
                  size="small"
                  min={0}
                  max={24}
                  step={0.5}
                  disabled={!canEdit || isFuture}
                  value={marks[w.workerId]?.otHours ?? 0}
                  onChange={(v) => set(w.workerId, { otHours: v ?? 0 })}
                  style={{ width: 80 }}
                />
              ) : (
                <Tooltip title="Piece-rate workers earn from the board, so overtime hours do not pay them.">
                  <Tag color="purple">piece rate</Tag>
                </Tooltip>
              ),
          },
          {
            title: 'Note',
            key: 'note',
            render: (_, w) => (
              <Input
                size="small"
                placeholder="reason, if any"
                disabled={!canEdit || isFuture}
                value={marks[w.workerId]?.note ?? ''}
                onChange={(e) => set(w.workerId, { note: e.target.value })}
              />
            ),
          },
          {
            title: 'Recorded',
            key: 'saved',
            width: 120,
            render: (_, w) =>
              w.status ? (
                <Tag color={ATTENDANCE_COLOR[w.status]}>{ATTENDANCE_LABEL[w.status]}</Tag>
              ) : (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {w.presumed === 'PRESENT' ? 'presumed present' : '—'}
                </Text>
              ),
          },
        ]}
      />
      <Text type="secondary" style={{ display: 'block', marginTop: 12 }}>
        Setting someone back to “{data?.presumePresent ? 'Presumed' : 'Not marked'}” deletes the exception, so the calendar decides again. Any past day can be opened and corrected —
        the money is recalculated from the marks, never stored.
      </Text>
    </div>
  );
}
