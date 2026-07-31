import { useState } from 'react';
import { Alert, App, Avatar, Breadcrumb, Button, Card, Col, Descriptions, Empty, Image, Popconfirm, Row, Space, Statistic, Table, Tabs, Tag, Tooltip, Typography, Upload } from 'antd';
import { HomeOutlined, UserOutlined, UploadOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api, apiError } from '../../api/client';
import {
  ATTENDANCE_COLOR,
  ATTENDANCE_LABEL,
  MANFORCE_KEYS,
  PAY_TYPE_COLOR,
  PAY_TYPE_LABEL,
  uploadWorkerDocuments,
  useWorker,
  useWorkerMonth,
  type AttendanceStatus,
  type EarningEvent,
  type StatementRow,
} from '../../api/manforce';
import { useAuth } from '../../auth/AuthContext';
import { money, num } from '../../util/format';
import ChangeLogList from '../../components/ChangeLogList';
import WorkerFormDrawer from './WorkerFormDrawer';
import PayWorkerModal from './PayWorkerModal';

const { Title, Text } = Typography;

const KIND_LABEL: Record<EarningEvent['kind'], string> = {
  DAY: 'Day',
  SALARY: 'Salary',
  OT: 'Overtime',
  PIECE: 'Piece work',
  MANUAL: 'Recorded by hand',
};

const KIND_COLOR: Record<EarningEvent['kind'], string> = { DAY: 'blue', SALARY: 'green', OT: 'orange', PIECE: 'purple', MANUAL: 'default' };

/**
 * One worker's whole position.
 *
 * `Due now` and `Balance` differ by exactly the advance still outstanding — that
 * identity is asserted in the server's self-checks, so the two figures can never drift.
 */
export default function WorkerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { hasRole } = useAuth();
  const canManage = hasRole('Manager');

  const { data: w, isLoading } = useWorker(id);
  const [month, setMonth] = useState(dayjs().format('YYYY-MM'));
  const { data: monthData } = useWorkerMonth(w?.id, month);
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState<'PAY' | 'ADVANCE' | 'DEDUCT' | null>(null);

  const refresh = () => {
    for (const key of MANFORCE_KEYS) qc.invalidateQueries({ queryKey: key });
  };

  const upload = useMutation({
    mutationFn: ({ files, kind }: { files: File[]; kind: 'PHOTO' | 'ID' }) => uploadWorkerDocuments(w!.id, files, kind),
    onSuccess: () => {
      message.success('Uploaded.');
      refresh();
    },
    onError: (e) => message.error(apiError(e)),
  });

  const delDoc = useMutation({
    mutationFn: (docId: number) => api.delete(`/worker-documents/${docId}`),
    onSuccess: () => {
      message.success('Removed.');
      refresh();
    },
    onError: (e) => message.error(apiError(e)),
  });

  const delAdvance = useMutation({
    mutationFn: (advanceId: number) => api.delete(`/advances/${advanceId}`),
    onSuccess: () => {
      message.success('Advance reversed — the payment went with it.');
      refresh();
    },
    onError: (e) => message.error(apiError(e)),
  });

  const delDeduction = useMutation({
    mutationFn: (dId: number) => api.delete(`/deductions/${dId}`),
    onSuccess: () => {
      message.success('Deduction removed.');
      refresh();
    },
    onError: (e) => message.error(apiError(e)),
  });

  if (!w) return <Card loading={isLoading} />;
  const p = w.position;
  const photo = w.documents.find((d) => d.kind === 'PHOTO');
  const ids = w.documents.filter((d) => d.kind === 'ID');

  return (
    <div>
      <Breadcrumb
        style={{ marginBottom: 16 }}
        items={[
          { title: <Link to="/"><HomeOutlined /></Link> },
          { title: <Link to="/manforce">Manforce</Link> },
          { title: <Link to="/manforce/workers">Workers</Link> },
          { title: w.code },
        ]}
      />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <Space align="start" size={16}>
          <Avatar src={photo?.url} icon={<UserOutlined />} size={64} />
          <div>
            <Title level={2} style={{ marginBottom: 2 }}>
              {w.name}
            </Title>
            <Space wrap>
              <Text type="secondary">{w.code}</Text>
              <Tag color={PAY_TYPE_COLOR[w.payType]}>{PAY_TYPE_LABEL[w.payType]}</Tag>
              {w.trade && <Tag>{w.trade.name}</Tag>}
              {w.contractor && <Tag color="geekblue">gang: {w.contractor.name}</Tag>}
              {!w.isActive && <Tag color="default">left{w.exitOn ? ` ${dayjs(w.exitOn).format('DD MMM YY')}` : ''}</Tag>}
            </Space>
          </div>
        </Space>
        {canManage && (
          <Space wrap>
            <Button icon={<EditOutlined />} onClick={() => setEditing(true)}>
              Edit
            </Button>
            {!w.contractorId && (
              <Button type="primary" onClick={() => setPaying('PAY')}>
                Pay wages
              </Button>
            )}
            <Button onClick={() => setPaying('ADVANCE')}>Give advance</Button>
            <Button onClick={() => setPaying('DEDUCT')}>Charge deduction</Button>
          </Space>
        )}
      </div>

      {w.contractorId && (
        <Alert
          style={{ marginTop: 16 }}
          type="info"
          showIcon
          message={`Paid through ${w.contractor?.name}`}
          description="Everything this worker earns rolls into that contractor's balance, and the contractor is who gets paid. The figures below explain their share of it."
          action={
            <Button size="small" onClick={() => navigate(`/finance/payments/contractor/${w.contractorId}`)}>
              Contractor statement
            </Button>
          }
        />
      )}

      {w.accrualFrom && (
        <Alert
          style={{ marginTop: 16 }}
          type="warning"
          showIcon
          message={`Wages are derived from ${dayjs(w.accrualFrom).format('DD MMM YYYY')} onwards`}
          description="Anything before that was recorded by hand before this module existed, so the engine deliberately does not accrue for it."
        />
      )}

      <Row gutter={[16, 16]} style={{ margin: '16px 0' }}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Earned so far (₹)" value={num(p.earned, 0)} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {p.earnedDays ? `${num(p.earnedDays, 1)} day(s)` : ''}
              {p.earnedPieces ? ` · ${p.earnedPieces} pc` : ''}
              {p.overtimeEarned ? ` · OT ₹${num(p.overtimeEarned, 0)}` : ''}
            </Text>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Paid out (₹)" value={num(p.paid + p.advanced, 0)} valueStyle={{ color: '#237804' }} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              wages {num(p.paid, 0)} · advances {num(p.advanced, 0)}
            </Text>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Tooltip title="What they can be handed today, after each advance's monthly recovery is taken out of their earnings.">
              <Statistic title="Due now (₹)" value={num(p.dueNow, 0)} valueStyle={{ color: p.dueNow > 0 ? '#cf1322' : '#237804' }} />
            </Tooltip>
            <Text type="secondary" style={{ fontSize: 12 }}>
              less deductions {num(p.deducted, 0)} · statutory {num(p.statutoryDeducted, 0)}
            </Text>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Tooltip title="Due now less the advance still outstanding. Negative means the worker is carrying an advance they have not yet worked off.">
              <Statistic title="Account balance (₹)" value={num(p.balance, 0)} valueStyle={{ color: p.balance < 0 ? '#d4380d' : '#1677ff' }} />
            </Tooltip>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {p.advanceOutstanding ? `advance out ₹${num(p.advanceOutstanding, 0)}` : 'no advance outstanding'}
            </Text>
          </Card>
        </Col>
      </Row>

      <Tabs
        items={[
          {
            key: 'statement',
            label: 'Statement',
            children: (
              <Card size="small">
                <Table<StatementRow>
                  rowKey="key"
                  size="small"
                  dataSource={[...w.statement].reverse()}
                  pagination={{ pageSize: 25 }}
                  columns={[
                    { title: 'Date', dataIndex: 'date', width: 110, render: (d) => dayjs(d).format('DD MMM YY') },
                    {
                      title: 'What',
                      dataIndex: 'description',
                      render: (v, r) => (
                        <span>
                          {v}
                          {r.detail && (
                            <>
                              <br />
                              <Text type="secondary" style={{ fontSize: 12 }}>
                                {r.detail}
                              </Text>
                            </>
                          )}
                        </span>
                      ),
                    },
                    { title: 'Earned', dataIndex: 'charge', width: 110, align: 'right', render: (v) => (v ? money(v, '₹', 0) : '') },
                    { title: 'Settled', dataIndex: 'settle', width: 110, align: 'right', render: (v) => (v ? money(v, '₹', 0) : '') },
                    { title: 'Balance', dataIndex: 'balance', width: 120, align: 'right', render: (v) => <b>{money(v, '₹', 0)}</b> },
                  ]}
                />
              </Card>
            ),
          },
          {
            key: 'earnings',
            label: `Earnings (${w.earnings.length})`,
            children: (
              <Card size="small">
                <Table<EarningEvent>
                  rowKey="key"
                  size="small"
                  dataSource={w.earnings}
                  pagination={{ pageSize: 25 }}
                  locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing has accrued yet" /> }}
                  columns={[
                    { title: 'Date', dataIndex: 'date', width: 110, render: (d) => dayjs(d).format('DD MMM YY') },
                    { title: 'Kind', dataIndex: 'kind', width: 130, render: (k: EarningEvent['kind']) => <Tag color={KIND_COLOR[k]}>{KIND_LABEL[k]}</Tag> },
                    {
                      title: 'What',
                      dataIndex: 'label',
                      render: (v, r) => (
                        <span>
                          {v}
                          {r.orderNumber && (
                            <>
                              {' '}
                              <Link to={`/operations/orders/${r.orderId}`}>{r.orderNumber}</Link>
                            </>
                          )}
                        </span>
                      ),
                    },
                    { title: 'Rate', dataIndex: 'rate', width: 110, align: 'right', render: (v, r) => (v ? `₹${num(v, 2)}${r.kind === 'PIECE' ? '/pc' : r.kind === 'OT' ? '/h' : ''}` : '') },
                    { title: 'Amount', dataIndex: 'amount', width: 110, align: 'right', render: (v) => <b>{money(v, '₹', 0)}</b> },
                  ]}
                />
              </Card>
            ),
          },
          {
            key: 'attendance',
            label: 'Attendance',
            children: (
              <Card
                size="small"
                title={
                  <Space>
                    <Button size="small" onClick={() => setMonth(dayjs(month + '-01').subtract(1, 'month').format('YYYY-MM'))}>
                      ‹
                    </Button>
                    {dayjs(month + '-01').format('MMMM YYYY')}
                    <Button size="small" onClick={() => setMonth(dayjs(month + '-01').add(1, 'month').format('YYYY-MM'))}>
                      ›
                    </Button>
                  </Space>
                }
                extra={
                  monthData ? (
                    <Text type="secondary">
                      {num(monthData.daysPaid, 1)} day(s) paid · {num(monthData.otHours, 1)} OT h · {money(monthData.earned, '₹', 0)}
                    </Text>
                  ) : null
                }
              >
                <Table
                  rowKey="date"
                  size="small"
                  pagination={false}
                  dataSource={monthData?.days ?? []}
                  columns={[
                    { title: 'Day', dataIndex: 'date', width: 130, render: (d) => dayjs(d).format('ddd DD MMM') },
                    {
                      title: 'Status',
                      dataIndex: 'status',
                      width: 200,
                      render: (s: AttendanceStatus | null, r) =>
                        s ? (
                          <Tag color={ATTENDANCE_COLOR[s]}>{ATTENDANCE_LABEL[s]}</Tag>
                        ) : r.holiday ? (
                          <Tag color="gold">{r.holiday}</Tag>
                        ) : !r.isWorkingDay ? (
                          <Text type="secondary">weekly off</Text>
                        ) : (
                          <Text type="secondary">presumed present</Text>
                        ),
                    },
                    { title: 'OT (h)', dataIndex: 'otHours', width: 90, align: 'right', render: (v) => (v ? num(v, 1) : '') },
                    { title: 'Worth', dataIndex: 'amount', width: 110, align: 'right', render: (v) => (v ? money(v, '₹', 0) : '—') },
                    { title: 'Note', dataIndex: 'note', render: (v) => v ?? '' },
                  ]}
                />
              </Card>
            ),
          },
          {
            key: 'advances',
            label: `Advances (${w.advances.length})`,
            children: (
              <Card size="small">
                <Table
                  rowKey="id"
                  size="small"
                  dataSource={w.advances}
                  pagination={false}
                  locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No advances" /> }}
                  columns={[
                    { title: 'Date', dataIndex: 'date', width: 110, render: (d) => dayjs(d).format('DD MMM YY') },
                    { title: 'Amount', dataIndex: 'amount', width: 110, align: 'right', render: (v) => money(v, '₹', 0) },
                    {
                      title: 'Recovery',
                      dataIndex: 'recoveryPerMonth',
                      width: 200,
                      render: (v: number) => (v > 0 ? `₹${num(v, 0)} a month from earnings` : <Text type="secondary">as fast as earnings allow</Text>),
                    },
                    { title: 'Recovered', dataIndex: 'recovered', width: 110, align: 'right', render: (v) => money(v, '₹', 0) },
                    {
                      title: 'Outstanding',
                      dataIndex: 'outstanding',
                      width: 120,
                      align: 'right',
                      render: (v: number) => (v > 0 ? <b style={{ color: '#d4380d' }}>{money(v, '₹', 0)}</b> : <Tag color="green">cleared</Tag>),
                    },
                    { title: 'Note', dataIndex: 'note', render: (v) => v ?? '' },
                    ...(canManage
                      ? [
                          {
                            title: '',
                            key: 'x',
                            width: 50,
                            render: (_: unknown, r: { id: number }) => (
                              <Popconfirm title="Reverse this advance?" description="The payment recorded with it is deleted too." onConfirm={() => delAdvance.mutate(r.id)}>
                                <Button size="small" danger type="text" icon={<DeleteOutlined />} />
                              </Popconfirm>
                            ),
                          },
                        ]
                      : []),
                  ]}
                />
              </Card>
            ),
          },
          {
            key: 'deductions',
            label: `Deductions (${w.deductions.length + w.statutoryPosted.length})`,
            children: (
              <Card size="small">
                <Table
                  rowKey={(r) => `${r.statutory ? 'stat' : 'ded'}-${r.id}`}
                  size="small"
                  pagination={false}
                  dataSource={[...w.deductions.map((d) => ({ ...d, statutory: false })), ...w.statutoryPosted.map((s) => ({ ...s, statutory: true }))]}
                  locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing charged to this worker" /> }}
                  columns={[
                    { title: 'Date', dataIndex: 'date', width: 110, render: (d) => dayjs(d).format('DD MMM YY') },
                    { title: 'Reason', dataIndex: 'label' },
                    { title: 'Amount', dataIndex: 'amount', width: 110, align: 'right', render: (v) => money(v, '₹', 0) },
                    {
                      title: '',
                      key: 'x',
                      width: 50,
                      render: (_: unknown, r: { id: number; statutory: boolean }) =>
                        canManage && !r.statutory ? (
                          <Popconfirm title="Remove this deduction?" onConfirm={() => delDeduction.mutate(r.id)}>
                            <Button size="small" danger type="text" icon={<DeleteOutlined />} />
                          </Popconfirm>
                        ) : r.statutory ? (
                          <Tooltip title="Created by a statutory posting — reverse the posting to remove it.">
                            <Tag color="blue">posted</Tag>
                          </Tooltip>
                        ) : null,
                    },
                  ]}
                />
              </Card>
            ),
          },
          {
            key: 'history',
            label: 'History',
            children: <ChangeLogList rootType="Worker" rootId={w.id} what="worker" />,
          },
          {
            key: 'file',
            label: 'Personnel file',
            children: (
              <Row gutter={[16, 16]}>
                <Col xs={24} md={12}>
                  <Card size="small" title="Details">
                    <Descriptions column={1} size="small" bordered>
                      <Descriptions.Item label="Phone">{w.phone || '—'}</Descriptions.Item>
                      <Descriptions.Item label="Alternate">{w.altPhone || '—'}</Descriptions.Item>
                      <Descriptions.Item label="Father / guardian">{w.guardianName || '—'}</Descriptions.Item>
                      <Descriptions.Item label="Emergency">{[w.emergencyName, w.emergencyPhone].filter(Boolean).join(' · ') || '—'}</Descriptions.Item>
                      <Descriptions.Item label="Date of birth">{w.dateOfBirth ? dayjs(w.dateOfBirth).format('DD MMM YYYY') : '—'}</Descriptions.Item>
                      <Descriptions.Item label="Address">{w.address || '—'}</Descriptions.Item>
                      <Descriptions.Item label="Aadhaar">{w.aadhaarNo || (canManage ? '—' : 'hidden')}</Descriptions.Item>
                      <Descriptions.Item label="PAN">{w.panNo || (canManage ? '—' : 'hidden')}</Descriptions.Item>
                      <Descriptions.Item label="UAN / ESIC">{[w.uanNo, w.esicNo].filter(Boolean).join(' · ') || (canManage ? '—' : 'hidden')}</Descriptions.Item>
                      <Descriptions.Item label="Bank">{[w.bankName, w.bankAccountNo, w.bankIfsc].filter(Boolean).join(' · ') || (canManage ? '—' : 'hidden')}</Descriptions.Item>
                      <Descriptions.Item label="UPI">{w.upiId || (canManage ? '—' : 'hidden')}</Descriptions.Item>
                      <Descriptions.Item label="Statutory cover">
                        {w.statutory.filter((s) => s.covered).length ? w.statutory.filter((s) => s.covered).map((s) => <Tag key={s.id}>{s.component.code}</Tag>) : <Text type="secondary">none</Text>}
                      </Descriptions.Item>
                      <Descriptions.Item label="Notes">{w.notes || '—'}</Descriptions.Item>
                    </Descriptions>
                  </Card>
                </Col>
                <Col xs={24} md={12}>
                  <Card
                    size="small"
                    title="Photo"
                    extra={
                      canManage && (
                        <Upload
                          showUploadList={false}
                          accept="image/*"
                          beforeUpload={(file) => {
                            upload.mutate({ files: [file], kind: 'PHOTO' });
                            return false;
                          }}
                        >
                          <Button size="small" icon={<UploadOutlined />} loading={upload.isPending}>
                            {photo ? 'Replace' : 'Upload'}
                          </Button>
                        </Upload>
                      )
                    }
                  >
                    {photo ? (
                      <Space align="start">
                        <Image src={photo.url} width={140} />
                        {canManage && (
                          <Popconfirm title="Remove this photo?" onConfirm={() => delDoc.mutate(photo.id)}>
                            <Button size="small" danger type="text" icon={<DeleteOutlined />} />
                          </Popconfirm>
                        )}
                      </Space>
                    ) : (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No photo" />
                    )}
                  </Card>
                  <Card
                    size="small"
                    title={`ID documents (${ids.length})`}
                    style={{ marginTop: 16 }}
                    extra={
                      canManage && (
                        <Upload
                          showUploadList={false}
                          multiple
                          accept="image/*"
                          beforeUpload={(file) => {
                            upload.mutate({ files: [file], kind: 'ID' });
                            return false;
                          }}
                        >
                          <Button size="small" icon={<UploadOutlined />} loading={upload.isPending}>
                            Add
                          </Button>
                        </Upload>
                      )
                    }
                  >
                    {ids.length ? (
                      <Space wrap>
                        {ids.map((d) => (
                          <div key={d.id} style={{ textAlign: 'center' }}>
                            <Image src={d.url} width={110} />
                            <br />
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              {d.label || d.originalName}
                            </Text>
                            {canManage && (
                              <Popconfirm title="Remove?" onConfirm={() => delDoc.mutate(d.id)}>
                                <Button size="small" danger type="text" icon={<DeleteOutlined />} />
                              </Popconfirm>
                            )}
                          </div>
                        ))}
                      </Space>
                    ) : (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing on file" />
                    )}
                  </Card>
                </Col>
              </Row>
            ),
          },
        ]}
      />

      <WorkerFormDrawer open={editing} worker={w} onClose={() => setEditing(false)} />
      <PayWorkerModal mode={paying} worker={w} onClose={() => setPaying(null)} />
    </div>
  );
}
