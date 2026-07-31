/**
 * The order page — the single record everything else hangs off.
 *
 * An order is what a person actually asks about ("where is ORD-2026-0003?"), so this page has
 * to answer every form of that question without sending anybody to a list: the board, what is
 * finished, which cartons it went into, which container carried them, which invoice billed
 * it, what the buyer has paid, which material sheets and drawings belong to it, and who
 * changed a price. The lists in the sidebar are for seeing everything at once; they are not
 * the way to reach one job.
 *
 * It is in TABS because of that, not despite it. Flat, the page ran to a dozen cards and the
 * board — the thing looked at daily — was buried in the middle of them. The headline figures
 * stay above the tabs so no tab has to repeat them.
 *
 * Nothing here is typed or added up. The board comes from the move ledger, the fulfilment
 * figures from `/orders/:id/fulfilment` (finished stock read live off that same board), and
 * the money from the one finance context. A figure that appears twice on this page is the
 * same server-side computation twice, never two.
 */
import { useState } from 'react';
import {
  Alert,
  App,
  Badge,
  Breadcrumb,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Image,
  Modal,
  Popconfirm,
  Progress,
  Result,
  Row,
  Skeleton,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from 'antd';
import {
  HomeOutlined,
  EditOutlined,
  ArrowLeftOutlined,
  ProfileOutlined,
  FilePdfOutlined,
  CalendarOutlined,
  BranchesOutlined,
  UndoOutlined,
  ShopOutlined,
  HomeFilled,
  HistoryOutlined,
  EyeOutlined,
  ThunderboltOutlined,
  WalletOutlined,
  CheckCircleOutlined,
  StopOutlined,
  BoxPlotOutlined,
  ContainerOutlined,
  FileProtectOutlined,
  InboxOutlined,
  ToolOutlined,
  FileTextOutlined,
} from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api, apiError } from '../../api/client';
import { useOrder, fetchDocument, DELIVERY_COLOUR, DELIVERY_TEXT, ORDER_STATUS_COLOR, MOVE_COLOR, MOVE_LABEL, OPS_KEYS, type MoveKind, type OrderLineDto } from '../../api/ops';
import { useOrderFulfilment, usePackQueue, SHIPMENT_STATUS_COLOR, INVOICE_STATUS_COLOR, packingListLabel } from '../../api/sales';
import { useAuth } from '../../auth/AuthContext';
import { money } from '../../util/format';
import StageStrip from './board/StageStrip';
import MoveDrawer, { type MoveTarget } from './board/MoveDrawer';
import RoutingDrawer from './board/RoutingDrawer';
import ScheduleDrawer from './board/ScheduleDrawer';
import BulkClearDrawer from './board/BulkClearDrawer';
import PackDrawer from '../sales/PackDrawer';
import ChangeLogList from '../../components/ChangeLogList';
import OrderAttachments from './OrderAttachments';

const { Title, Text } = Typography;

export default function OrderDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { message, modal } = App.useApp();
  const { hasRole } = useAuth();
  const editable = hasRole('Operator');
  const { data: o, isLoading, isError } = useOrder(id);
  /** Everything that happened after the board finished — one read, all of it derived. */
  const { data: f } = useOrderFulfilment(id);
  /**
   * The packing queue carries the product's carton dimensions and weights, which the
   * fulfilment payload deliberately does not — so the pack drawer is fed from the same
   * endpoint the Packing page uses, filtered to this order. One shape, one set of pre-fills.
   */
  const { data: packQueue = [] } = usePackQueue();

  const [tab, setTab] = useState('production');
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const [routingLine, setRoutingLine] = useState<OrderLineDto | null>(null);
  const [scheduleLine, setScheduleLine] = useState<OrderLineDto | null>(null);
  const [historyLine, setHistoryLine] = useState<OrderLineDto | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [packOpen, setPackOpen] = useState(false);

  const invalidate = () => {
    for (const key of OPS_KEYS) qc.invalidateQueries({ queryKey: key });
  };

  // Confirmed / Production / Ready / Shipped are DERIVED from the board and the shipments,
  // so the only statuses a human sets are the terminal ones. `Reopen` hands the order back
  // to the board.
  const setStatus = useMutation({
    mutationFn: (status: 'Closed' | 'Cancelled') => api.patch(`/orders/${id}/status`, { status }),
    onSuccess: (_r, status) => {
      message.success(status === 'Closed' ? 'Order closed.' : 'Order cancelled.');
      invalidate();
    },
    onError: (e: unknown) => message.error(apiError(e)),
  });

  const reopen = useMutation({
    mutationFn: () => api.post(`/orders/${id}/reopen`),
    onSuccess: () => {
      message.success('Reopened — its status follows the board again.');
      invalidate();
    },
    onError: (e: unknown) => message.error(apiError(e)),
  });

  const undoMove = useMutation({
    mutationFn: (moveId: number) => api.delete(`/moves/${moveId}`),
    onSuccess: () => {
      message.success('Movement undone.');
      invalidate();
      setHistoryLine(null);
    },
    onError: (e) => message.error(apiError(e)),
  });

  const makeSheet = useMutation({
    mutationFn: (line: OrderLineDto) => api.post('/operation-sheets', { orderLineId: line.id }),
    onSuccess: (res) => navigate(`/operations/sheets/${(res.data as any).id}`),
    onError: (e) => message.error(apiError(e)),
  });

  if (isLoading) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (isError || !o) return <Result status="404" title="Order not found" extra={<Button onClick={() => navigate('/operations/orders')}>Back to orders</Button>} />;

  const symbol = o.currency?.symbol ?? '₹';
  const s = o.summary;
  const m = o.money;
  const canManage = hasRole('Manager');
  // Closed and Cancelled are the terminal states a human owns; everything else follows the
  // board and the shipments.
  const terminal = o.status === 'Closed' || o.status === 'Cancelled';
  const missingRoutes = o.lines.filter((l) => l.needsStageLine);
  const anyPieces = o.lines.some((l) => l.board.stages.some((st) => st.at > 0));
  // A vendor stage left at ₹0 silently bills nothing — worth saying out loud.
  const unratedStages = o.lines.flatMap((l) =>
    l.board.stages.filter((st) => st.vendorId && st.jobworkRate <= 0).map((st) => ({ line: l, stage: st }))
  );

  const ft = f?.totals;
  /** This order's rows of the packing queue — what the pack drawer opens on. */
  const myQueue = packQueue.filter((r) => r.orderId === o.id && r.availableToPack > 0);
  const sheetCount = o.lines.filter((l) => l.sheet).length;

  const cancelOrder = () =>
    modal.confirm({
      title: `Cancel order ${o.number}?`,
      content: 'Production movements are kept, but nothing further can be moved and the order drops out of the money totals.',
      okText: 'Cancel the order',
      okButtonProps: { danger: true },
      cancelText: 'Keep it open',
      onOk: () => setStatus.mutate('Cancelled'),
    });

  // -------------------------------------------------------------------------
  // Production — the board, and the two things that stop it working
  // -------------------------------------------------------------------------

  const production = (
    <>
      {missingRoutes.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`${missingRoutes.length} line(s) have no stage line yet`}
          description="Pieces cannot move until a route is set. Open “Who makes this?” on the line, or set a stage line on the product."
        />
      )}

      {unratedStages.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="A vendor stage has no jobwork rate, so it is billing nothing"
          description={
            <span>
              {unratedStages.map((u, i) => (
                <span key={`${u.line.id}-${u.stage.id}`}>
                  {i > 0 && ' · '}
                  <b>{u.stage.vendor?.name}</b> on “{u.stage.name}” of {u.line.product.factoryCode}
                  {u.stage.cleared > 0 ? ` (${u.stage.cleared} pcs already cleared)` : ''}
                </span>
              ))}
              . Set a ₹/pc rate in “Who makes this?” and the amount owed fills in for the pieces already done.
            </span>
          }
          action={
            editable && (
              <Button size="small" onClick={() => setRoutingLine(unratedStages[0].line)}>
                Set rate
              </Button>
            )
          }
        />
      )}

      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {o.lines.map((l) => (
          <Card
            key={l.id}
            size="small"
            className="board-line-card"
            styles={{ body: { paddingTop: 10 } }}
            title={
              <Space wrap size={8}>
                {l.product.primaryImage && <img src={l.product.primaryImage} alt="" className="board-thumb" />}
                <Link to={`/products/${l.product.id}`} style={{ fontWeight: 600 }}>
                  {l.product.factoryCode}
                </Link>
                <Text>{l.product.name}</Text>
                <Tag color="#6d4c41">{l.qty} pcs</Tag>
                {l.stageLine ? (
                  <Tag>
                    {l.stageLine.code} · {l.stageLine.name}
                  </Tag>
                ) : (
                  <Tag color="orange">No stage line</Tag>
                )}
                {l.mode === 'INHOUSE' ? (
                  <Tag icon={<HomeFilled />}>All in-house</Tag>
                ) : (
                  l.vendors.map((v) => (
                    <Tag key={v.id} color="volcano" icon={<ShopOutlined />}>
                      {v.name}: {l.outsourcedStages.filter((x) => x.id === v.id).map((x) => x.sortOrder + 1).join(', ')}
                    </Tag>
                  ))
                )}
              </Space>
            }
            extra={
              <Space wrap>
                <Text type="secondary">{money(l.amount, symbol)}</Text>
                {editable && (
                  <Button size="small" icon={<BranchesOutlined />} onClick={() => setRoutingLine(l)}>
                    Who makes this?
                  </Button>
                )}
                {editable && !l.needsStageLine && (
                  <Button size="small" icon={<CalendarOutlined />} onClick={() => setScheduleLine(l)}>
                    {l.schedule ? 'Schedule' : 'Set a schedule'}
                  </Button>
                )}
                {l.schedule?.isBehind && (
                  <Tooltip title={`A stage is ${l.schedule.daysLate} day(s) past its planned end.`}>
                    <Tag color="orange" style={{ margin: 0 }}>
                      behind
                    </Tag>
                  </Tooltip>
                )}
                <Button size="small" icon={<HistoryOutlined />} disabled={l.history.length === 0} onClick={() => setHistoryLine(l)}>
                  History ({l.history.length})
                </Button>
                {l.sheet ? (
                  <Button size="small" icon={<EyeOutlined />} onClick={() => navigate(`/operations/sheets/${l.sheet!.id}`)}>
                    {l.sheet.number}
                  </Button>
                ) : (
                  editable && (
                    <Button size="small" icon={<ProfileOutlined />} loading={makeSheet.isPending} onClick={() => makeSheet.mutate(l)}>
                      Material sheet
                    </Button>
                  )
                )}
              </Space>
            }
          >
            {l.needsStageLine ? (
              <Empty image={null} description={<Text type="secondary">No stage line on this line — set one to start tracking pieces.</Text>} style={{ margin: '8px 0' }}>
                {editable && (
                  <Button type="primary" ghost size="small" icon={<BranchesOutlined />} onClick={() => setRoutingLine(l)}>
                    Set stage line
                  </Button>
                )}
              </Empty>
            ) : (
              <>
                <StageStrip order={o} line={l} editable={editable} onMove={setMoveTarget} />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, gap: 12, flexWrap: 'wrap' }}>
                  <Space size={8}>
                    <Progress percent={l.board.progressPct} size="small" style={{ width: 120 }} strokeColor="#6d4c41" />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {l.board.done} finished
                      {l.board.wip > 0 ? ` · ${l.board.wip} on the floor` : ''}
                      {l.board.pending > 0 ? ` · ${l.board.pending} not started` : ''}
                    </Text>
                  </Space>
                  <Space size={4} wrap>
                    {l.board.jobwork.map((j) => (
                      <Tag key={j.vendorId} color="volcano">
                        {j.vendorName}: {money(j.amount, '₹')} ({j.pieces} pcs)
                      </Tag>
                    ))}
                    {editable && (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        Click a bucket to pass pieces on with a note and photos · ✓ passes the lot straight on
                      </Text>
                    )}
                  </Space>
                </div>
              </>
            )}
          </Card>
        ))}
      </Space>
    </>
  );

  // -------------------------------------------------------------------------
  // Fulfilment — finished stock, cartons, containers, invoices
  // -------------------------------------------------------------------------

  const fulfilment = (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title={
          <Space>
            <BoxPlotOutlined /> Finished, packed, shipped, billed
          </Space>
        }
        extra={
          <Space wrap>
            {editable && myQueue.length > 0 && (
              <Button size="small" type="primary" ghost icon={<BoxPlotOutlined />} onClick={() => setPackOpen(true)}>
                Pack {ft?.availableToPack ?? 0} pc
              </Button>
            )}
            {canManage && (ft?.availableToShip ?? 0) > 0 && (
              <Button size="small" icon={<ContainerOutlined />} onClick={() => navigate(`/sales/shipments/new?buyerId=${o.buyer.id}`)}>
                Ship {ft!.availableToShip} pc
              </Button>
            )}
            <Button size="small" icon={<InboxOutlined />} onClick={() => navigate('/sales/stock')}>
              Finished stock
            </Button>
          </Space>
        }
      >
        <Table
          size="small"
          rowKey="orderLineId"
          pagination={false}
          dataSource={f?.lines ?? []}
          locale={{ emptyText: 'Nothing finished on this order yet.' }}
          columns={[
            {
              title: 'Item',
              key: 'item',
              render: (_, r) => (
                <Space size={6}>
                  <Link to={`/products/${r.productId}`} style={{ fontWeight: 600 }}>
                    {r.productCode}
                  </Link>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {r.productName}
                  </Text>
                </Space>
              ),
            },
            { title: 'Ordered', dataIndex: 'ordered', align: 'right', width: 90 },
            {
              title: 'Finished',
              key: 'finished',
              align: 'right',
              width: 105,
              render: (_, r) => (
                <span>
                  {r.boardDone + r.adjusted + r.returned}
                  {/* Made beyond the order: real stock, but it belongs to no line. */}
                  {r.overProduced > 0 && (
                    <Tooltip title={`${r.overProduced} pc beyond the order — free-pool stock any order may draw on.`}>
                      <Tag color="gold" style={{ marginLeft: 4 }}>
                        +{r.overProduced}
                      </Tag>
                    </Tooltip>
                  )}
                </span>
              ),
            },
            { title: 'Packed', dataIndex: 'packed', align: 'right', width: 90 },
            { title: 'Shipped', dataIndex: 'shipped', align: 'right', width: 90, render: (v: number) => <Text strong={v > 0}>{v}</Text> },
            {
              title: 'Invoiced',
              dataIndex: 'invoiced',
              align: 'right',
              width: 95,
              render: (v: number, r) => (
                <Tooltip title={v < r.shipped ? `${r.shipped - v} pc have gone out and are not billed yet.` : undefined}>
                  <Text type={v < r.shipped ? 'warning' : undefined}>{v}</Text>
                </Tooltip>
              ),
            },
            {
              title: 'Ready',
              key: 'ready',
              align: 'right',
              width: 155,
              render: (_, r) => (
                <Space size={4}>
                  {r.availableToPack > 0 && <Tag color="blue">{r.availableToPack} to pack</Tag>}
                  {r.availableToShip > 0 && <Tag color="green">{r.availableToShip} to ship</Tag>}
                  {r.availableToPack === 0 && r.availableToShip === 0 && <Text type="secondary">—</Text>}
                </Space>
              ),
            },
          ]}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          Finished comes straight off the board — undo a completion and this un-does itself. A dispatch may only draw on cartons, which is what the packing step is for.
        </Text>
      </Card>

      {/* The cartons themselves, and where each went. */}
      <Card
        size="small"
        title={
          <Space>
            <BoxPlotOutlined /> Cartons packed ({f?.batches.length ?? 0})
          </Space>
        }
        extra={<Button size="small" onClick={() => navigate('/sales/packing')}>Packing</Button>}
      >
        {(f?.batches.length ?? 0) === 0 ? (
          <Text type="secondary">Nothing packed against this order yet.</Text>
        ) : (
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={f!.batches}
            columns={[
              { title: 'Packed', dataIndex: 'packedOn', width: 105, render: (d: string) => dayjs(d).format('DD MMM YY') },
              { title: 'Item', dataIndex: 'productCode', width: 120, render: (v: string) => <b>{v}</b> },
              { title: 'Pieces', dataIndex: 'qty', align: 'right', width: 80 },
              {
                title: 'Cartons',
                key: 'cartons',
                align: 'right',
                width: 115,
                render: (_, b) => (
                  <span>
                    {b.cartonCount}
                    {b.lastCartonPieces > 0 && (
                      <Tooltip title={`The last box holds ${b.lastCartonPieces} pc.`}>
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          {' '}
                          (part)
                        </Text>
                      </Tooltip>
                    )}
                  </span>
                ),
              },
              {
                title: 'CBM',
                key: 'cbm',
                align: 'right',
                width: 100,
                render: (_, b) => (
                  <Tooltip
                    title={`${b.cbmPerCarton.toFixed(4)} per carton — ${
                      b.cbmSource === 'OVERRIDE' ? 'measured' : b.cbmSource === 'STORED' ? 'from the product' : 'from the dimensions'
                    }`}
                  >
                    {b.totalCbm.toFixed(3)}
                  </Tooltip>
                ),
              },
              { title: 'Gross kg', key: 'gross', align: 'right', width: 95, render: (_, b) => b.totalGrossKg.toFixed(1) },
              {
                title: 'Gone out',
                key: 'out',
                width: 220,
                render: (_, b) =>
                  b.shipments.length === 0 ? (
                    <Tag>still here</Tag>
                  ) : (
                    <Space size={4} wrap>
                      {b.shipments.map((sh) => (
                        <Link key={`${sh.shipmentId}-${sh.cartons}`} to={`/sales/shipments/${sh.shipmentId}`}>
                          <Tag color="blue">
                            {sh.number} · {sh.cartons} ctn
                          </Tag>
                        </Link>
                      ))}
                      {b.availableCartons > 0 && <Tag color="green">{b.availableCartons} left</Tag>}
                    </Space>
                  ),
              },
              { title: 'Marks', dataIndex: 'shippingMarks', render: (v: string | null) => v || '—' },
            ]}
          />
        )}
      </Card>

      {/* Dispatches, with the boxes they went in. */}
      <Card
        size="small"
        title={
          <Space>
            <ContainerOutlined /> Shipments ({f?.shipments.length ?? 0})
          </Space>
        }
        extra={
          canManage && (
            <Button size="small" onClick={() => navigate('/sales/shipments')}>
              All shipments
            </Button>
          )
        }
      >
        {(f?.shipments.length ?? 0) === 0 ? (
          <Text type="secondary">Nothing has left against this order yet.</Text>
        ) : (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            {f!.shipments.map((sh) => (
              <Card key={sh.id} size="small" type="inner" styles={{ body: { paddingBlock: 10 } }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <Space wrap size={8}>
                    <Link to={`/sales/shipments/${sh.id}`} style={{ fontWeight: 600 }}>
                      {sh.number}
                    </Link>
                    <Tag color={SHIPMENT_STATUS_COLOR[sh.status] ?? 'default'}>{sh.status}</Tag>
                    {sh.shipDate && <Text type="secondary">{dayjs(sh.shipDate).format('DD MMM YYYY')}</Text>}
                    <Text>
                      {sh.mine.cartons} ctn · {sh.mine.pieces} pc from this order
                    </Text>
                    {/* One container may hold two buyers' goods, so say when the box totals
                        below are not this order's. */}
                    {sh.coLoaded && (
                      <Tooltip
                        title={`Co-loaded with ${sh.orders
                          .filter((x) => x.orderId !== o.id)
                          .map((x) => x.number)
                          .join(', ')}. The container figures are for the whole box.`}
                      >
                        <Tag color="purple">co-loaded</Tag>
                      </Tooltip>
                    )}
                  </Space>
                  <Space wrap size={6}>
                    {sh.invoices.map((v) => (
                      <Link key={v.id} to={`/finance/invoices/${v.id}`}>
                        <Tag color={INVOICE_STATUS_COLOR[v.status] ?? 'default'} icon={<FileProtectOutlined />}>
                          {v.number}
                        </Tag>
                      </Link>
                    ))}
                    {/* Gone and unbilled is the row somebody actually has to act on. */}
                    {sh.invoices.length === 0 && sh.status !== 'PLANNED' && <Tag color="orange">not invoiced</Tag>}
                    <Tooltip title={`Packing list ${packingListLabel(sh.number)}, VGM, annexure and certificate of origin`}>
                      <Button size="small" type="text" icon={<FilePdfOutlined />} onClick={() => navigate(`/sales/shipments/${sh.id}`)}>
                        Documents
                      </Button>
                    </Tooltip>
                  </Space>
                </div>
                {sh.containers.length > 0 && (
                  <Row gutter={[10, 10]} style={{ marginTop: 10 }}>
                    {sh.containers.map((c) => (
                      <Col key={c.id} xs={24} sm={12} lg={8}>
                        <div style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: '8px 10px' }}>
                          <Space size={6} wrap>
                            <Tag color="#4e342e">{c.code}</Tag>
                            <Text strong style={{ fontSize: 12 }}>
                              {c.containerNo || 'no container no.'}
                            </Text>
                            {c.sealNo && (
                              <Text type="secondary" style={{ fontSize: 11 }}>
                                seal {c.sealNo}
                              </Text>
                            )}
                          </Space>
                          {/* A capacity of 0 means "not a container" — an LCL part load, which
                              can never be over capacity. */}
                          {c.capacityCbm > 0 ? (
                            <>
                              <Progress
                                percent={Math.min(100, Math.round(c.fit.cbmPct))}
                                size="small"
                                status={c.fit.overCbm ? 'exception' : 'normal'}
                                strokeColor="#6d4c41"
                                format={() => `${c.fit.cbmPct.toFixed(0)}% vol`}
                              />
                              <Progress
                                percent={Math.min(100, Math.round(c.fit.kgPct))}
                                size="small"
                                status={c.fit.overKg ? 'exception' : 'normal'}
                                strokeColor="#8d6e63"
                                format={() => `${c.fit.kgPct.toFixed(0)}% wt`}
                              />
                            </>
                          ) : (
                            <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
                              part load — no capacity to fill
                            </Text>
                          )}
                          <Text type="secondary" style={{ fontSize: 11 }}>
                            {c.load.cartons} ctn · {c.load.cbm.toFixed(3)} CBM · VGM {c.vgmKg.toFixed(0)} kg
                          </Text>
                        </div>
                      </Col>
                    ))}
                  </Row>
                )}
                {sh.unassigned.cartons > 0 && (
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {sh.unassigned.cartons} carton(s) on this shipment are not in a container yet.
                  </Text>
                )}
              </Card>
            ))}
          </Space>
        )}
      </Card>

      {/* Billing, reachable from the job it bills. */}
      <Card
        size="small"
        title={
          <Space>
            <FileProtectOutlined /> Invoices ({f?.invoices.length ?? 0})
          </Space>
        }
        extra={
          canManage && (
            <Button size="small" onClick={() => navigate('/finance/invoices')}>
              All invoices
            </Button>
          )
        }
      >
        {(f?.invoices.length ?? 0) === 0 ? (
          <Text type="secondary">
            Nothing billed against this order yet. An invoice is raised from its shipment, because its money comes from what actually went out.
          </Text>
        ) : (
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={f!.invoices}
            columns={[
              {
                title: 'Invoice',
                key: 'invoice',
                width: 190,
                render: (_, i) => (
                  <Space size={6}>
                    <Link to={`/finance/invoices/${i.id}`} style={{ fontWeight: 600 }}>
                      {i.number}
                    </Link>
                    <Tag color={INVOICE_STATUS_COLOR[i.status] ?? 'default'}>{i.status}</Tag>
                  </Space>
                ),
              },
              { title: 'Date', dataIndex: 'invoiceDate', width: 110, render: (d: string) => dayjs(d).format('DD MMM YY') },
              { title: 'Pieces', key: 'pieces', width: 85, align: 'right', render: (_, i) => i.mine.pieces },
              {
                title: 'Shipment',
                key: 'shipment',
                width: 140,
                render: (_, i) => (i.shipment ? <Link to={`/sales/shipments/${i.shipment.id}`}>{i.shipment.number}</Link> : '—'),
              },
              {
                title: 'Document total',
                key: 'total',
                align: 'right',
                render: (_, i) => (
                  <span>
                    <Text strong>{money(i.totals.grandTotal, i.currency?.symbol ?? '₹')}</Text>
                    {/* An invoice may bill several orders, so its total is not this order's. */}
                    {i.spansOrders && (
                      <Tooltip
                        title={`Also bills ${i.orders
                          .filter((x) => x.orderId !== o.id)
                          .map((x) => x.number)
                          .join(', ')} — this is the whole document.`}
                      >
                        <Tag color="purple" style={{ marginLeft: 6 }}>
                          spans orders
                        </Tag>
                      </Tooltip>
                    )}
                  </span>
                ),
              },
            ]}
          />
        )}
      </Card>
    </Space>
  );

  // -------------------------------------------------------------------------
  // Paperwork — the order's own details, its files and every document it can print
  // -------------------------------------------------------------------------

  const paperwork = (
    <Row gutter={16}>
      <Col xs={24} lg={14}>
        <Card size="small" title="Order details">
          <Descriptions column={2} size="small" bordered>
            <Descriptions.Item label="Buyer">{o.buyer.name}</Descriptions.Item>
            <Descriptions.Item label="Currency">{o.currency?.code ?? 'INR'}</Descriptions.Item>
            <Descriptions.Item label="Order date">{dayjs(o.orderDate).format('DD MMM YYYY')}</Descriptions.Item>
            <Descriptions.Item label="Delivery">{o.deliveryDate ? dayjs(o.deliveryDate).format('DD MMM YYYY') : '—'}</Descriptions.Item>
            <Descriptions.Item label="Incoterms">{o.incoterms || '—'}</Descriptions.Item>
            <Descriptions.Item label="From proforma">
              {o.proforma ? <Link to={`/operations/proformas/${o.proforma.id}`}>{o.proforma.number}</Link> : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Notes" span={2}>
              {o.notes || '—'}
            </Descriptions.Item>
          </Descriptions>
        </Card>

        <div style={{ marginTop: 16 }}>
          <OrderAttachments orderId={o.id} orderNumber={o.number} />
        </div>
      </Col>
      <Col xs={24} lg={10}>
        {/* A material sheet belongs to an order LINE, so this is the one place they are all
            listed together — the Material Sheets page is a list of everyone's. */}
        <Card
          size="small"
          title={
            <Space>
              <ProfileOutlined /> Material sheets
            </Space>
          }
          extra={
            <Button size="small" onClick={() => navigate('/operations/sheets')}>
              All sheets
            </Button>
          }
        >
          {o.lines.length === 0 ? (
            <Text type="secondary">No lines on this order.</Text>
          ) : (
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              {o.lines.map((l) => (
                <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <Space size={6}>
                    <Link to={`/products/${l.product.id}`}>{l.product.factoryCode}</Link>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {l.qty} pcs
                    </Text>
                  </Space>
                  {l.sheet ? (
                    <Button size="small" type="link" icon={<EyeOutlined />} onClick={() => navigate(`/operations/sheets/${l.sheet!.id}`)}>
                      {l.sheet.number}
                    </Button>
                  ) : editable ? (
                    <Button size="small" type="text" loading={makeSheet.isPending} onClick={() => makeSheet.mutate(l)}>
                      Make one
                    </Button>
                  ) : (
                    <Text type="secondary">—</Text>
                  )}
                </div>
              ))}
            </Space>
          )}
          <Text type="secondary" style={{ fontSize: 12 }}>
            {sheetCount} of {o.lines.length} line(s) have a sheet. A sheet is the costing explosion for that line's quantity; it holds no progress.
          </Text>
        </Card>

        <Card
          size="small"
          title={
            <Space>
              <FilePdfOutlined /> Documents
            </Space>
          }
          style={{ marginTop: 16 }}
        >
          <Space direction="vertical" style={{ width: '100%' }} size={8}>
            <Button block icon={<FilePdfOutlined />} onClick={() => fetchDocument(`/orders/${o.id}/pdf`, `${o.number}.pdf`, true).catch((e) => message.error(apiError(e)))}>
              Order confirmation PDF
            </Button>
            {/* The packing list, VGM, annexure and certificate of origin describe a
                CONTAINER, not an order, so they are reached through the dispatch. */}
            {(f?.shipments.length ?? 0) > 0 ? (
              f!.shipments.map((sh) => (
                <Button key={sh.id} block icon={<ContainerOutlined />} onClick={() => navigate(`/sales/shipments/${sh.id}`)}>
                  {sh.number} — packing list, VGM, annexure, CoO
                </Button>
              ))
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>
                Shipping paperwork appears here once something has been dispatched — it describes a container, not an order.
              </Text>
            )}
            {f?.invoices.map((i) => (
              <Button key={i.id} block icon={<FileProtectOutlined />} onClick={() => navigate(`/finance/invoices/${i.id}`)}>
                {i.number} — invoice PDF and e-mail draft
              </Button>
            ))}
          </Space>
        </Card>
      </Col>
    </Row>
  );

  // -------------------------------------------------------------------------
  // Money — this order's position, and the way through to Finance
  // -------------------------------------------------------------------------

  const moneyTab = (
    <Row gutter={16}>
      <Col xs={24} lg={14}>
        <Card
          size="small"
          title={
            <Space>
              <WalletOutlined /> Money on this order
            </Space>
          }
        >
          <Row gutter={[16, 12]}>
            <Col xs={12} md={8}>
              <Statistic title="Invoiced" value={money(m.invoiced, symbol)} valueStyle={{ fontSize: 17 }} />
            </Col>
            <Col xs={12} md={8}>
              <Statistic title="Received" value={money(m.received, symbol)} valueStyle={{ fontSize: 17, color: '#237804' }} />
            </Col>
            <Col xs={12} md={8}>
              <Statistic
                title="Still to collect"
                value={money(m.receivable, symbol)}
                valueStyle={{ fontSize: 17, color: m.receivable > 0 ? '#cf1322' : '#237804' }}
              />
              {m.exchangeRate !== 1 && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  ≈ {money(m.receivableInr, '₹')}
                </Text>
              )}
            </Col>
            <Col xs={12} md={8}>
              <Statistic title="Jobwork earned" value={money(m.jobworkAccrued, '₹')} valueStyle={{ fontSize: 17 }} />
              <Text type="secondary" style={{ fontSize: 12 }}>
                paid {money(m.jobworkPaid, '₹')}
              </Text>
            </Col>
            <Col xs={12} md={8}>
              <Statistic title="Owed out (₹)" value={money(m.payableInr, '₹')} valueStyle={{ fontSize: 17, color: m.payableInr > 0 ? '#cf1322' : '#237804' }} />
              <Text type="secondary" style={{ fontSize: 12 }}>
                jobwork {money(m.jobworkDue, '₹')}
                {m.materialDue ? ` · material ${money(m.materialDue, '₹')}` : ''}
                {m.wagesDue ? ` · wages ${money(m.wagesDue, '₹')}` : ''}
              </Text>
            </Col>
          </Row>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Jobwork earned counts each outsourced stage as its pieces clear. Nothing here is typed — receipts and vendor payments are recorded in Finance, and which debt a payment settles is worked out oldest-first rather than chosen.
          </Text>
          <Space wrap style={{ marginTop: 12 }}>
            <Button size="small" icon={<WalletOutlined />} onClick={() => navigate(`/finance/payments/buyer/${o.buyer.id}`)}>
              {o.buyer.name}'s statement
            </Button>
            <Button size="small" onClick={() => navigate('/finance/payments')}>
              Receipts &amp; Payments
            </Button>
            {canManage && (
              <Button size="small" icon={<FileProtectOutlined />} onClick={() => navigate('/finance/invoices')}>
                Invoices
              </Button>
            )}
          </Space>
        </Card>

        <Card size="small" title={`Money entries aimed at this order (${o.ledger.length})`} style={{ marginTop: 16 }}>
          {o.ledger.length === 0 ? (
            <Text type="secondary">No receipts or payments recorded against this order yet.</Text>
          ) : (
            <>
              <Space direction="vertical" style={{ width: '100%' }} size={6}>
                {o.ledger.map((e) => (
                  <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <Space size={6}>
                      <Tag color={e.partyType === 'BUYER' ? 'green' : 'volcano'}>{e.partyType === 'BUYER' ? 'IN' : 'OUT'}</Tag>
                      <Text style={{ fontSize: 12 }}>{e.partyName}</Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {dayjs(e.date).format('DD MMM')}
                        {e.ref ? ` · ${e.ref}` : ''}
                      </Text>
                    </Space>
                    <Text strong>
                      {e.currency ?? 'INR'} {e.amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </Text>
                  </div>
                ))}
              </Space>
              <Text type="secondary" style={{ fontSize: 12 }}>
                A row's order is only where the money was AIMED. Where it actually landed is worked out oldest-debt-first — the buyer's statement shows the split.
              </Text>
            </>
          )}
        </Card>
      </Col>
      <Col xs={24} lg={10}>
        {o.jobwork.length > 0 && (
          <Card size="small" title="Jobwork earned so far" style={{ marginBottom: 16 }}>
            <Space direction="vertical" style={{ width: '100%' }} size={4}>
              {o.jobwork.map((j) => (
                <div key={j.vendorId} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span>
                    <Text>{j.vendorName}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {' '}
                      {j.stages.join(', ')}
                    </Text>
                  </span>
                  <Space size={6}>
                    <Text strong>{money(j.amount, '₹')}</Text>
                    <Button size="small" type="link" onClick={() => navigate(`/finance/payments/jobwork/${j.vendorId}`)}>
                      statement
                    </Button>
                  </Space>
                </div>
              ))}
            </Space>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Counted per piece as each outsourced stage clears.
            </Text>
          </Card>
        )}
        <Card size="small" title="What this order is worth">
          <Descriptions column={1} size="small">
            <Descriptions.Item label="Items">{money(o.totals.subtotal, symbol)}</Descriptions.Item>
            {o.totals.chargeTotal !== 0 && <Descriptions.Item label="Charges">{money(o.totals.chargeTotal, symbol)}</Descriptions.Item>}
            {o.totals.taxed && (
              <Descriptions.Item label={o.totals.intraState ? 'CGST + SGST' : 'IGST'}>
                {money(o.totals.intraState ? o.totals.taxTotal : o.totals.igst, symbol)}
              </Descriptions.Item>
            )}
            <Descriptions.Item label="Grand total">
              <Text strong>{money(o.total, symbol)}</Text>
            </Descriptions.Item>
          </Descriptions>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {o.totals.taxed
              ? 'A domestic sale: whether it is CGST + SGST or IGST is derived by comparing the buyer’s state with the company’s, never typed.'
              : 'An export: zero-rated end to end, so every rate on the document is ignored rather than trusted.'}
          </Text>
        </Card>
      </Col>
    </Row>
  );

  return (
    <div>
      <Breadcrumb
        style={{ marginBottom: 16 }}
        items={[
          { title: <Link to="/"><HomeOutlined /></Link> },
          { title: <Link to="/operations/orders">Orders</Link> },
          { title: o.number },
        ]}
      />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <Space wrap>
          <Title level={3} style={{ margin: 0 }}>
            {o.number}
          </Title>
          <Tooltip
            title={
              terminal
                ? `${o.status} is a manual decision — reopen to hand it back to the board.`
                : 'Follows the board and the shipments automatically — Confirmed → Production → Ready → Shipped.'
            }
          >
            <Tag color={ORDER_STATUS_COLOR[o.status] ?? 'default'}>{o.status}</Tag>
          </Tooltip>
          {/* Will it make its date? Derived from the board, so always current. */}
          {o.delivery && o.delivery.status !== 'NO_DATE' && (
            <Tooltip title={o.delivery.reason}>
              <Tag color={DELIVERY_COLOUR[o.delivery.status] ?? 'default'}>{DELIVERY_TEXT[o.delivery.status] ?? o.delivery.status}</Tag>
            </Tooltip>
          )}
          <Text type="secondary">
            {o.buyer.name}
            {o.deliveryDate ? ` · delivery ${dayjs(o.deliveryDate).format('DD MMM YYYY')}` : ''}
          </Text>
        </Space>
        <Space wrap>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/operations/orders')}>
            Back
          </Button>
          {editable && anyPieces && (
            <Button icon={<ThunderboltOutlined />} onClick={() => setBulkOpen(true)}>
              Clear a stage
            </Button>
          )}
          <Button
            icon={<FilePdfOutlined />}
            onClick={() => fetchDocument(`/orders/${o.id}/pdf`, `${o.number}.pdf`, true).catch((e) => message.error(apiError(e)))}
          >
            Order PDF
          </Button>
          {/* Status is DERIVED (see the tag above); the only status a human sets is a
              terminal one. When the order is already Closed/Cancelled, the one action is to
              reopen it and hand it back to the board. */}
          {canManage &&
            (terminal ? (
              <Popconfirm
                title={`Reopen ${o.number}?`}
                description="Its status will follow the board and the shipments again."
                okText="Reopen"
                onConfirm={() => reopen.mutate()}
              >
                <Button icon={<UndoOutlined />} loading={reopen.isPending}>
                  Reopen
                </Button>
              </Popconfirm>
            ) : (
              <>
                <Popconfirm
                  title={`Close ${o.number}?`}
                  description="A closed order is finished business — nothing further moves and it can be reopened if needed."
                  okText="Close order"
                  onConfirm={() => setStatus.mutate('Closed')}
                >
                  <Button icon={<CheckCircleOutlined />} loading={setStatus.isPending}>
                    Close
                  </Button>
                </Popconfirm>
                <Button danger icon={<StopOutlined />} onClick={cancelOrder}>
                  Cancel
                </Button>
              </>
            ))}
          {editable && !terminal && (
            <Button icon={<EditOutlined />} onClick={() => navigate(`/operations/orders/${o.id}/edit`)}>
              Edit order
            </Button>
          )}
        </Space>
      </div>

      {/*
        The whole job in one strip, above the tabs: pieces through production, the same pieces
        through fulfilment, and what the buyer still owes. Whichever tab is open, the headline
        figures stay on screen — which is what lets each tab hold detail instead of repeating
        a summary.
      */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Row gutter={[16, 12]} align="middle">
          <Col xs={24} md={8}>
            <Text type="secondary">
              {s.done} of {s.ordered} pcs finished
            </Text>
            <Progress percent={s.progressPct} status={s.progressPct >= 100 ? 'success' : 'active'} strokeColor="#6d4c41" />
            <Space size={12} wrap>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {s.pending} not started
              </Text>
              <Text style={{ fontSize: 12, color: '#874d00' }}>{s.wip} in production</Text>
              <Text style={{ fontSize: 12, color: '#237804' }}>{s.done} finished</Text>
            </Space>
          </Col>
          {/* Fulfilment sits on the same strip as production because the pieces are the same
              pieces — the split into two modules is a menu convenience, not a real boundary. */}
          <Col xs={8} md={3}>
            <Statistic title="Packed" value={ft?.packed ?? 0} valueStyle={{ fontSize: 20 }} />
            {(ft?.availableToPack ?? 0) > 0 && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                {ft!.availableToPack} ready
              </Text>
            )}
          </Col>
          <Col xs={8} md={3}>
            <Statistic title="Shipped" value={ft?.shipped ?? 0} valueStyle={{ fontSize: 20, color: '#0958d9' }} />
            {(ft?.availableToShip ?? 0) > 0 && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                {ft!.availableToShip} in boxes
              </Text>
            )}
          </Col>
          <Col xs={8} md={3}>
            <Statistic
              title="Billed"
              value={ft?.invoiced ?? 0}
              valueStyle={{ fontSize: 20, color: (ft?.invoiced ?? 0) < (ft?.shipped ?? 0) ? '#d46b08' : undefined }}
            />
            {(ft?.shipped ?? 0) > (ft?.invoiced ?? 0) && (
              <Text type="warning" style={{ fontSize: 11 }}>
                {ft!.shipped - ft!.invoiced} gone, unbilled
              </Text>
            )}
          </Col>
          <Col xs={24} md={7} style={{ textAlign: 'right' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Order value
            </Text>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#4e342e' }}>{money(o.total, symbol)}</div>
            <Space size={6} wrap style={{ justifyContent: 'flex-end' }}>
              {/* A domestic order's total is goods + charges + GST, so say which is which. */}
              {(o.totals?.taxed || (o.totals?.charges?.length ?? 0) > 0) && (
                <Tooltip
                  title={
                    <span>
                      Items {money(o.totals.subtotal, symbol)}
                      {o.totals.chargeTotal !== 0 && <> · charges {money(o.totals.chargeTotal, symbol)}</>}
                      {o.totals.taxed && (
                        <> · {o.totals.intraState ? `CGST+SGST ${money(o.totals.taxTotal, symbol)}` : `IGST ${money(o.totals.igst, symbol)}`}</>
                      )}
                    </span>
                  }
                >
                  <Tag color={o.totals.taxed ? (o.totals.intraState ? 'geekblue' : 'purple') : 'gold'} style={{ margin: 0 }}>
                    {o.totals.taxed ? (o.totals.intraState ? 'incl. CGST + SGST' : 'incl. IGST') : 'export · zero rated'}
                  </Tag>
                </Tooltip>
              )}
              <Tooltip title="Still to collect on this order">
                <Tag color={m.receivable > 0 ? 'red' : 'green'} style={{ margin: 0 }}>
                  {money(m.receivable, symbol)} to collect
                </Tag>
              </Tooltip>
            </Space>
          </Col>
        </Row>
      </Card>

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'production',
            label: (
              <Space size={6}>
                <ToolOutlined /> Production
                {/* A dot rather than a count: these two alerts block work, they are not a tally. */}
                {(missingRoutes.length > 0 || unratedStages.length > 0) && <Badge dot />}
              </Space>
            ),
            children: production,
          },
          {
            key: 'fulfilment',
            label: (
              <Space size={6}>
                <ContainerOutlined /> Fulfilment
                {(f?.shipments.length ?? 0) > 0 && <Badge count={f!.shipments.length} color="#8d6e63" />}
              </Space>
            ),
            children: fulfilment,
          },
          {
            key: 'paperwork',
            label: (
              <Space size={6}>
                <FileTextOutlined /> Paperwork
                {o.attachments.length > 0 && <Badge count={o.attachments.length} color="#bcaaa4" />}
              </Space>
            ),
            children: paperwork,
          },
          {
            key: 'money',
            label: (
              <Space size={6}>
                <WalletOutlined /> Money
              </Space>
            ),
            children: moneyTab,
          },
          {
            key: 'history',
            label: (
              <Space size={6}>
                <HistoryOutlined /> History
              </Space>
            ),
            children: (
              <Card size="small" title="Who changed a price or a rate, and what it was before">
                <ChangeLogList rootType="Order" rootId={o.id} what="order" />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Only money and rates are logged — a log of every keystroke would bury the one entry anybody ever needs. Piece movements are on each line under Production.
                </Text>
              </Card>
            ),
          },
        ]}
      />

      <MoveDrawer order={o} target={moveTarget} onClose={() => setMoveTarget(null)} />
      <RoutingDrawer order={o} line={routingLine} onClose={() => setRoutingLine(null)} />
      <ScheduleDrawer order={o} line={scheduleLine} onClose={() => setScheduleLine(null)} />
      <BulkClearDrawer order={o} open={bulkOpen} onClose={() => setBulkOpen(false)} />
      {/* Mounted only while open, because the drawer seeds its rows from props on first
          render — the same reason the Packing page mounts it that way. */}
      {packOpen && <PackDrawer rows={myQueue} onClose={() => setPackOpen(false)} />}

      <Modal open={!!historyLine} onCancel={() => setHistoryLine(null)} footer={null} width={680} title={historyLine ? `Movements — ${historyLine.product.factoryCode}` : ''}>
        {historyLine && (
          <>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Newest first. Only the newest movement of a line can be undone.
            </Text>
            <Timeline
              style={{ marginTop: 16 }}
              items={historyLine.history.map((h, i) => ({
                color: MOVE_COLOR[h.kind as MoveKind] ?? 'gray',
                children: (
                  <div>
                    <Space wrap size={6}>
                      <Tag color={MOVE_COLOR[h.kind as MoveKind]}>{MOVE_LABEL[h.kind as MoveKind] ?? h.kind}</Tag>
                      <Text strong>{h.qty} pcs</Text>
                      <Text>
                        {h.fromStage ?? (h.kind === 'RETURN' ? 'Finished' : 'Not started')} → {h.toStage ?? (h.kind === 'REJECT' ? 'Not started' : 'Finished')}
                      </Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {dayjs(h.date).format('DD MMM YYYY')}
                      </Text>
                    </Space>
                    {h.note && <div style={{ fontSize: 12, whiteSpace: 'pre-line', margin: '2px 0' }}>{h.note}</div>}
                    {h.workers.length > 0 && (
                      <Space size={4} wrap style={{ marginTop: 2 }}>
                        {h.workers.map((w) => (
                          <Tooltip key={w.workerId} title={`${w.pieces} pc by ${w.name}`}>
                            <Tag color="cyan" style={{ margin: 0 }}>
                              <Link to={`/manforce/workers/${w.workerId}`}>{w.name}</Link> · {w.pieces}
                            </Tag>
                          </Tooltip>
                        ))}
                        {h.labourValue > 0 && (
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            earned {money(h.labourValue, '₹', 0)}
                          </Text>
                        )}
                      </Space>
                    )}
                    {h.photos.length > 0 && (
                      <Image.PreviewGroup>
                        <Space size={6} wrap style={{ marginTop: 4 }}>
                          {h.photos.map((p) => (
                            <Image key={p.id} src={p.url} width={52} height={52} style={{ objectFit: 'cover', borderRadius: 4, border: '1px solid #eee' }} />
                          ))}
                        </Space>
                      </Image.PreviewGroup>
                    )}
                    {i === 0 && editable && (
                      <Popconfirm
                        title="Undo this movement?"
                        description="The pieces go back where they came from, and its photos are deleted."
                        onConfirm={() => undoMove.mutate(h.id)}
                        okButtonProps={{ danger: true }}
                      >
                        <Button size="small" type="text" danger icon={<UndoOutlined />} loading={undoMove.isPending}>
                          Undo
                        </Button>
                      </Popconfirm>
                    )}
                  </div>
                ),
              }))}
            />
          </>
        )}
      </Modal>
    </div>
  );
}
