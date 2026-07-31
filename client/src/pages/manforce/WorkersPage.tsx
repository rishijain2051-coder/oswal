import { useMemo, useState } from 'react';
import { Avatar, Breadcrumb, Button, Card, Input, Segmented, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { HomeOutlined, PlusOutlined, UserOutlined, SearchOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { PAY_TYPE_COLOR, PAY_TYPE_LABEL, useContractors, useTrades, useWorkers, type Worker } from '../../api/manforce';
import { useAuth } from '../../auth/AuthContext';
import { num } from '../../util/format';
import WorkerFormDrawer from './WorkerFormDrawer';

const { Title, Text } = Typography;

/**
 * Everyone on the books.
 *
 * The money column is optional because it costs a full pass over attendance and the
 * board to work out — it is never stored, so asking for it means computing it.
 */
export default function WorkersPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const canManage = can('workers.manage');

  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'active' | 'all'>('active');
  const [payType, setPayType] = useState<string | undefined>();
  const [contractorId, setContractorId] = useState<number | undefined>();
  const [showMoney, setShowMoney] = useState(true);
  const [editing, setEditing] = useState<Worker | 'new' | null>(null);

  const params = useMemo(
    () => ({ ...(scope === 'active' ? { active: '1' } : {}), ...(payType ? { payType } : {}), ...(contractorId ? { contractorId } : {}), ...(showMoney ? { money: '1' } : {}) }),
    [scope, payType, contractorId, showMoney]
  );
  const { data: workers, isLoading } = useWorkers(params);
  const { data: trades } = useTrades();
  const { data: contractors } = useContractors();

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return workers ?? [];
    return (workers ?? []).filter((w) => [w.name, w.code, w.phone, w.trade?.name, w.contractor?.name].some((v) => v?.toLowerCase().includes(needle)));
  }, [workers, q]);

  const columns = [
    {
      title: 'Worker',
      dataIndex: 'name',
      render: (_: unknown, w: Worker) => (
        <Space>
          <Avatar src={w.photoUrl ?? undefined} icon={<UserOutlined />} size="small" />
          <span>
            <Link to={`/manforce/workers/${w.id}`}>{w.name}</Link>
            <br />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {w.code}
              {w.trade ? ` · ${w.trade.name}` : ''}
            </Text>
          </span>
        </Space>
      ),
    },
    {
      title: 'Paid by',
      dataIndex: 'payType',
      width: 190,
      render: (t: Worker['payType'], w: Worker) => (
        <span>
          <Tag color={PAY_TYPE_COLOR[t]}>{PAY_TYPE_LABEL[t]}</Tag>
          <br />
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t === 'DAY' ? `₹ ${num(w.dailyRate, 0)}/day` : t === 'MONTHLY' ? `₹ ${num(w.monthlySalary, 0)}/month` : 'off the board'}
            {w.otHourlyRate ? ` · OT ₹${num(w.otHourlyRate, 0)}/h` : ''}
          </Text>
        </span>
      ),
    },
    {
      title: 'Paid through',
      dataIndex: 'contractorId',
      width: 150,
      render: (_: unknown, w: Worker) =>
        w.contractor ? (
          <Tooltip title="Their wages roll up into this contractor's balance — the contractor is paid, not the worker.">
            <Tag color="geekblue">{w.contractor.name}</Tag>
          </Tooltip>
        ) : (
          <Text type="secondary">the factory</Text>
        ),
    },
    ...(showMoney
      ? [
          {
            title: 'Earned',
            key: 'earned',
            width: 130,
            align: 'right' as const,
            render: (_: unknown, w: Worker) =>
              w.money ? (
                <span>
                  ₹ {num(w.money.earned, 0)}
                  <br />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {w.money.days ? `${num(w.money.days, 1)} day(s)` : ''}
                    {w.money.pieces ? ` ${w.money.pieces} pc` : ''}
                  </Text>
                </span>
              ) : null,
          },
          {
            title: 'Due now',
            key: 'due',
            width: 140,
            align: 'right' as const,
            render: (_: unknown, w: Worker) => {
              if (!w.money) return null;
              if (w.contractorId) return <Text type="secondary">via gang</Text>;
              return (
                <span>
                  <b style={{ color: w.money.dueNow > 0 ? '#cf1322' : '#237804' }}>₹ {num(w.money.dueNow, 0)}</b>
                  {w.money.advanceOutstanding > 0 && (
                    <>
                      <br />
                      <Tooltip title="Advance handed over that their earnings have not yet absorbed.">
                        <Tag color="volcano" style={{ marginTop: 2 }}>
                          adv ₹{num(w.money.advanceOutstanding, 0)}
                        </Tag>
                      </Tooltip>
                    </>
                  )}
                </span>
              );
            },
          },
        ]
      : []),
    {
      title: 'Since',
      dataIndex: 'joinedOn',
      width: 110,
      render: (d: string, w: Worker) => (
        <span>
          {dayjs(d).format('DD MMM YY')}
          {!w.isActive && (
            <>
              <br />
              <Tag color="default">left {w.exitOn ? dayjs(w.exitOn).format('DD MMM YY') : ''}</Tag>
            </>
          )}
        </span>
      ),
    },
    ...(canManage
      ? [
          {
            title: '',
            key: 'actions',
            width: 80,
            render: (_: unknown, w: Worker) => (
              <Button size="small" onClick={() => setEditing(w)}>
                Edit
              </Button>
            ),
          },
        ]
      : []),
  ];

  return (
    <div>
      <Breadcrumb
        style={{ marginBottom: 16 }}
        items={[{ title: <Link to="/"><HomeOutlined /></Link> }, { title: <Link to="/manforce">Manforce</Link> }, { title: 'Workers' }]}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <Title level={2} style={{ marginBottom: 2 }}>
            Workers
          </Title>
          <Text type="secondary">Every worker is a running account: earnings accrue, payments happen whenever.</Text>
        </div>
        {canManage && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
            Add worker
          </Button>
        )}
      </div>

      <Card size="small" style={{ margin: '16px 0' }}>
        <Space wrap>
          {/* id/name so the browser can identify the field; autoComplete off because a
              filter term is not data worth remembering. */}
          <Input
            id="worker-search"
            name="worker-search"
            autoComplete="off"
            allowClear
            prefix={<SearchOutlined />}
            placeholder="Name, code, phone…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ width: 240 }}
          />
          <Segmented value={scope} onChange={(v) => setScope(v as 'active' | 'all')} options={[{ label: 'On the books', value: 'active' }, { label: 'Everyone', value: 'all' }]} />
          <Select
            allowClear
            placeholder="Paid by"
            style={{ width: 160 }}
            value={payType}
            onChange={setPayType}
            options={Object.entries(PAY_TYPE_LABEL).map(([value, label]) => ({ value, label }))}
          />
          <Select
            allowClear
            placeholder="Gang"
            style={{ width: 180 }}
            value={contractorId}
            onChange={setContractorId}
            options={(contractors ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.workers})` }))}
          />
          <Segmented
            value={showMoney ? 'money' : 'plain'}
            onChange={(v) => setShowMoney(v === 'money')}
            options={[
              { label: 'With money', value: 'money' },
              { label: 'Names only', value: 'plain' },
            ]}
          />
          <Text type="secondary">
            {filtered.length} of {workers?.length ?? 0}
            {trades?.length ? ` · ${trades.length} trade(s)` : ''}
          </Text>
        </Space>
      </Card>

      <Table
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={filtered}
        columns={columns as never}
        pagination={{ pageSize: 25, showSizeChanger: true }}
        onRow={(w) => ({ onDoubleClick: () => navigate(`/manforce/workers/${w.id}`) })}
      />

      <WorkerFormDrawer open={editing != null} worker={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
    </div>
  );
}
