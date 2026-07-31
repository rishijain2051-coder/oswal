import { Alert, Breadcrumb, Card, Col, Empty, List, Row, Statistic, Tag, Typography } from 'antd';
import { HomeOutlined, TeamOutlined, CalendarOutlined, WalletOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { useManforceSummary } from '../../api/manforce';
import { useAuth } from '../../auth/AuthContext';
import { num } from '../../util/format';

const { Title, Text } = Typography;

/** Each card names the permission that opens its page, so none of them leads to a refusal. */
const SECTIONS = [
  { key: 'workers', title: 'Workers', icon: <TeamOutlined />, path: '/manforce/workers', desc: 'Everyone on the books — trade, rates, documents and a running account each.', needs: ['workers.view'] },
  { key: 'muster', title: 'Muster Roll', icon: <CalendarOutlined />, path: '/manforce/muster', desc: 'Mark the day. Everyone is presumed present, so you only record the exceptions.', needs: ['workers.view', 'muster.view'] },
  { key: 'wages', title: 'Wages & Advances', icon: <WalletOutlined />, path: '/manforce/wages', desc: 'Pay anyone any amount any day, hand over advances, charge deductions.', needs: ['workers.view', 'wages.view'] },
  { key: 'statutory', title: 'Statutory', icon: <SafetyCertificateOutlined />, path: '/manforce/statutory', desc: 'PF, ESI and the rest — computed from wages earned, owed only once you post it.', needs: ['workers.view', 'statutory.view'] },
];

/**
 * The Manforce landing page.
 *
 * Every money figure is derived from attendance and the production board, so it needs
 * no reconciliation — what it shows is simply what the rules say, today.
 */
export default function ManforceHome() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const { data: d } = useManforceSummary();
  const t = d?.today;

  const dayLabel = !t ? '' : t.holiday ? `Holiday — ${t.holiday}` : t.isWorkingDay ? 'Working day' : 'Weekly off';
  /** Null without `wages.view` — the server withholds it, so this is the one presence test. */
  const wages = d?.money ?? null;

  return (
    <div>
      <Breadcrumb style={{ marginBottom: 16 }} items={[{ title: <Link to="/"><HomeOutlined /></Link> }, { title: 'Manforce' }]} />
      <Title level={2} style={{ marginBottom: 2 }}>
        Manforce
      </Title>
      <Text type="secondary">Workers, attendance and wages. Nobody is on a pay cycle — every worker is a running account.</Text>

      {(d?.unlinked?.length ?? 0) > 0 && (
        <Alert
          style={{ marginTop: 16 }}
          type="warning"
          showIcon
          message={`${d!.unlinked.length} wage account${d!.unlinked.length === 1 ? '' : 's'} still recorded against a typed name`}
          description={
            <span>
              {d!.unlinked.map((u) => u.partyName).join(', ')} — these predate this module. Run <code>npm run db:workers</code> to turn them into real worker records; their balances carry over untouched.
            </span>
          }
        />
      )}

      <Row gutter={[16, 16]} style={{ margin: '16px 0' }}>
        <Col xs={12} md={6}>
          <Card size="small" hoverable onClick={() => navigate('/manforce/workers')}>
            <Statistic title="On the books" value={d?.headcount ?? 0} valueStyle={{ color: '#1677ff' }} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {d?.gangWorkers ?? 0} in {d?.contractors ?? 0} gang(s)
            </Text>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" hoverable onClick={() => navigate('/manforce/muster')}>
            <Statistic title="Present today" value={t?.present ?? 0} valueStyle={{ color: '#237804' }} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {dayLabel}
              {t && t.absent ? ` · ${t.absent} away` : ''}
              {t && t.halfDay ? ` · ${t.halfDay} half day` : ''}
            </Text>
          </Card>
        </Col>
        {/* The money half of the dashboard needs `wages.view`, and the server sends the whole
            block as null without it. Hidden rather than zeroed: five cards reading ₹0 would
            say the factory owes nobody anything, which is a claim and not an absence. */}
        {wages && (
          <>
            <Col xs={12} md={6}>
              <Card size="small" hoverable onClick={() => navigate('/manforce/wages')}>
                <Statistic title="Wages owed (₹)" value={num(wages.workerDue, 0)} valueStyle={{ color: '#cf1322' }} />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  gangs {num(wages.contractorDue, 0)} ₹
                </Text>
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small" hoverable onClick={() => navigate('/manforce/statutory')}>
                <Statistic title="Statutory posted (₹)" value={num(wages.statutoryDue, 0)} valueStyle={{ color: '#d46b08' }} />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {wages.statutoryProvision ? `provisions ${num(wages.statutoryProvision, 0)} ₹` : 'nothing unposted becomes a debt'}
                </Text>
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small">
                <Statistic title="Wages accrued (₹)" value={num(wages.wagesAccrued, 0)} />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  from attendance and the board
                </Text>
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small">
                <Statistic title="Paid out (₹)" value={num(wages.wagesPaid, 0)} valueStyle={{ color: '#237804' }} />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  wages and advances together
                </Text>
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small" hoverable onClick={() => navigate('/manforce/wages')}>
                <Statistic title="Advances out (₹)" value={num(wages.advanceOutstanding, 0)} valueStyle={{ color: '#d4380d' }} />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  still to be worked off
                </Text>
              </Card>
            </Col>
          </>
        )}
        <Col xs={12} md={6}>
          <Card size="small" hoverable onClick={() => navigate('/manforce/muster')}>
            <Statistic title="Overtime today (h)" value={num(t?.overtimeHours ?? 0, 1)} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t?.marked ?? 0} exception(s) recorded
            </Text>
          </Card>
        </Col>
      </Row>

      {/* Both panels are lists of named people with amounts against them, so they are wages
          and the server sends them empty without `wages.view`. They must be HIDDEN rather than
          shown empty: "Nobody is owed anything yet" beside a real ₹4.3 lakh payable is not a
          blank slate, it is a false statement. */}
      {wages && (
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} md={12}>
          <Card size="small" title="Who is owed the most" extra={<Link to="/manforce/wages">pay someone</Link>}>
            <List
              size="small"
              dataSource={d?.topDue ?? []}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nobody is owed anything yet" /> }}
              renderItem={(w) => (
                <List.Item onClick={() => navigate(`/manforce/workers/${w.id}`)} style={{ cursor: 'pointer' }}>
                  <span>
                    <b>{w.name}</b> <Text type="secondary">{w.code}</Text>
                  </span>
                  <span>
                    <Tag color="red">₹ {num(w.dueNow, 0)}</Tag>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      earned {num(w.earned, 0)}
                    </Text>
                  </span>
                </List.Item>
              )}
            />
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card
            size="small"
            title="Advances being worked off"
            extra={
              d?.lastPosting ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  last posting {d.lastPosting.number} · {dayjs(d.lastPosting.periodTo).format('DD MMM')}
                </Text>
              ) : null
            }
          >
            <List
              size="small"
              dataSource={d?.advances ?? []}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No advances outstanding" /> }}
              renderItem={(w) => (
                <List.Item onClick={() => navigate(`/manforce/workers/${w.id}`)} style={{ cursor: 'pointer' }}>
                  <span>
                    <b>{w.name}</b> <Text type="secondary">{w.code}</Text>
                  </span>
                  <span>
                    <Tag color="volcano">₹ {num(w.outstanding, 0)} left</Tag>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {num(w.recovered, 0)} recovered
                    </Text>
                  </span>
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>
      )}

      <Row gutter={[16, 16]}>
        {SECTIONS.filter((s) => can(...s.needs)).map((s) => (
          <Col key={s.key} xs={24} sm={12} lg={6}>
            <Card className="module-card" onClick={() => navigate(s.path)} style={{ height: '100%', borderTop: '4px solid #00695c' }}>
              <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                <div style={{ fontSize: 28, color: '#00695c' }}>{s.icon}</div>
                <div>
                  <Title level={4} style={{ margin: 0 }}>
                    {s.title}
                  </Title>
                  <Text type="secondary">{s.desc}</Text>
                </div>
              </div>
            </Card>
          </Col>
        ))}
      </Row>
    </div>
  );
}
