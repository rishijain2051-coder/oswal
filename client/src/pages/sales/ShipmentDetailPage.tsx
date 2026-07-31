import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Breadcrumb, Button, Card, Descriptions, Modal, Progress, Result, Select, Space, Spin, Table, Tag, Tooltip, Typography } from 'antd';
import { FilePdfOutlined, HomeOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  annexurePdf,
  invalidateSales,
  originPdf,
  packingListLabel,
  packingListPdf,
  raiseInvoice,
  setShipmentStatus,
  SHIPMENT_STATUS_COLOR,
  useShipment,
  vgmPdf,
} from '../../api/sales';
import { apiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';

const { Title, Text } = Typography;

const STATUSES = ['PLANNED', 'LOADED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];

export default function ShipmentDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { can } = useAuth();
  const { data: s, isLoading, error } = useShipment(id);
  const [invoicing, setInvoicing] = useState(false);
  const [invoiceBuyer, setInvoiceBuyer] = useState<number>();

  /**
   * EVERY hook has to run before the early returns below — React counts them by position,
   * so a `useMutation` after a conditional `return` changes the hook order between the
   * loading render and the loaded one and white-screens the page.
   */
  const status = useMutation({
    mutationFn: (next: string) => setShipmentStatus(s!.id, next),
    onSuccess: (r: { status: string }) => {
      message.success(`Marked ${r.status.toLowerCase()}.`);
      invalidateSales(qc);
    },
    onError: (e) => message.error(apiError(e)),
  });

  const invoice = useMutation({
    mutationFn: () => raiseInvoice(s!.id, { buyerId: invoiceBuyer! }),
    onSuccess: (v) => {
      message.success(`${v.number} raised as a draft.`);
      invalidateSales(qc);
      setInvoicing(false);
      nav(`/finance/invoices/${v.id}`);
    },
    onError: (e) => message.error(apiError(e)),
  });

  if (!can('shipments.view')) return <Result status="403" title="No access to shipments" subTitle='This needs the "See shipments" permission.' />;
  if (isLoading) return <Spin />;
  // Say what went wrong rather than spinning forever: a 404 or a 410 leaves `isLoading`
  // false and the data undefined, which an `isLoading || !s` guard would sit on indefinitely.
  if (error || !s)
    return (
      <Result
        status="404"
        title="Shipment not found"
        subTitle={error ? apiError(error) : 'It may have been deleted.'}
        extra={
          <Button type="primary" onClick={() => nav('/sales/shipments')}>
            Back to shipments
          </Button>
        }
      />
    );

  const overseas = s.markets.includes('OVERSEAS');
  const issued = s.invoices.filter((v) => v.status !== 'CANCELLED');

  const doc = (fn: () => Promise<void>) => () => fn().catch((e) => message.error(apiError(e)));

  return (
    <div>
      <Breadcrumb
        style={{ marginBottom: 12 }}
        items={[
          { title: <Link to="/"><HomeOutlined /></Link> },
          { title: <Link to="/sales">Dispatch</Link> },
          { title: <Link to="/sales/shipments">Shipments</Link> },
          { title: s.number },
        ]}
      />
      <Space style={{ justifyContent: 'space-between', width: '100%', marginBottom: 12 }} align="start">
        <Space align="center">
          <Title level={4} style={{ margin: 0 }}>
            {s.number}
          </Title>
          <Tag color={SHIPMENT_STATUS_COLOR[s.status] ?? 'default'}>{s.status}</Tag>
        </Space>
        <Space wrap>
          <Select
            size="small"
            style={{ width: 130 }}
            value={s.status}
            onChange={(v) => status.mutate(v)}
            options={STATUSES.map((v) => ({ value: v, label: v }))}
            disabled={issued.length > 0 && s.status !== 'CANCELLED'}
          />
          <Button size="small" icon={<FilePdfOutlined />} onClick={doc(() => packingListPdf(s))}>
            Packing list
          </Button>
          {overseas && (
            <>
              <Tooltip title={s.containers.length ? '' : 'Add a container first — there is no gross mass to declare.'}>
                <Button size="small" icon={<FilePdfOutlined />} disabled={!s.containers.length} onClick={doc(() => vgmPdf(s))}>
                  VGM
                </Button>
              </Tooltip>
              <Button size="small" icon={<FilePdfOutlined />} onClick={doc(() => annexurePdf(s))}>
                Annexure
              </Button>
              <Button size="small" icon={<FilePdfOutlined />} onClick={doc(() => originPdf(s))}>
                Origin
              </Button>
            </>
          )}
          <Button size="small" onClick={() => nav(`/sales/shipments/${s.id}/edit`)} disabled={issued.length > 0}>
            Edit
          </Button>
          {/* One invoice per buyer per shipment; the server enforces it. */}
          <Button
            size="small"
            type="primary"
            disabled={s.status === 'PLANNED' || s.status === 'CANCELLED' || !s.orders.length}
            onClick={() => {
              setInvoiceBuyer(s.orders[0]?.buyerId);
              setInvoicing(true);
            }}
          >
            Raise invoice
          </Button>
        </Space>
      </Space>

      {s.status === 'PLANNED' && <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Not shipped yet. Nothing can be billed until it has gone." />}
      {issued.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={
            <>
              {issued.map((v) => (
                <Link key={v.id} to={`/finance/invoices/${v.id}`} style={{ marginRight: 8 }}>
                  {v.number}
                </Link>
              ))}
              has been raised against this shipment, so what shipped can no longer be changed.
            </>
          }
        />
      )}

      <Card size="small" style={{ marginBottom: 12 }}>
        <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }}>
          <Descriptions.Item label="Shipped">{s.shipDate ? dayjs(s.shipDate).format('DD MMM YYYY') : '—'}</Descriptions.Item>
          <Descriptions.Item label="Cartons">{s.totals.cartons}</Descriptions.Item>
          <Descriptions.Item label="Pieces">{s.totals.pieces}</Descriptions.Item>
          <Descriptions.Item label="Volume">{s.totals.cbm.toFixed(3)} CBM</Descriptions.Item>
          <Descriptions.Item label="Net weight">{s.totals.netKg.toFixed(2)} kg</Descriptions.Item>
          <Descriptions.Item label="Gross weight">{s.totals.grossKg.toFixed(2)} kg</Descriptions.Item>
          <Descriptions.Item label="Packing list">{packingListLabel(s.number)}</Descriptions.Item>
          {s.shippingBillNo && <Descriptions.Item label="Shipping bill">{s.shippingBillNo}</Descriptions.Item>}
          {s.portOfLoading && <Descriptions.Item label="Port of loading">{s.portOfLoading}</Descriptions.Item>}
          {s.portOfDischarge && <Descriptions.Item label="Port of discharge">{s.portOfDischarge}</Descriptions.Item>}
          {s.finalDestination && <Descriptions.Item label="Destination">{s.finalDestination}</Descriptions.Item>}
          {s.vesselOrFlight && <Descriptions.Item label="Vessel / flight">{s.vesselOrFlight}</Descriptions.Item>}
          {s.blAwbNo && <Descriptions.Item label="BL / AWB">{s.blAwbNo}</Descriptions.Item>}
          {s.transporterName && <Descriptions.Item label="Transporter">{s.transporterName}</Descriptions.Item>}
          {s.vehicleNo && <Descriptions.Item label="Vehicle">{s.vehicleNo}</Descriptions.Item>}
          {s.ewayBillNo && <Descriptions.Item label="E-way bill">{s.ewayBillNo}</Descriptions.Item>}
        </Descriptions>
      </Card>

      <Card size="small" title="What is on board" style={{ marginBottom: 12 }}>
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={s.lines}
          columns={[
            { title: 'Product', render: (_, l) => `${l.productCode} — ${l.productName}` },
            { title: 'Order', render: (_, l) => (l.orderId ? <Link to={`/operations/orders/${l.orderId}`}>{l.orderNumber}</Link> : '—') },
            { title: 'Buyer', dataIndex: 'buyerName' },
            { title: 'Marks', dataIndex: 'shippingMarks', ellipsis: true },
            { title: 'Cartons', dataIndex: 'cartons', align: 'right' as const, width: 80 },
            { title: 'Pieces', dataIndex: 'qty', align: 'right' as const, width: 80 },
            { title: 'Net kg', dataIndex: 'netKg', align: 'right' as const, width: 80, render: (v: number) => v.toFixed(2) },
            { title: 'Gross kg', dataIndex: 'grossKg', align: 'right' as const, width: 90, render: (v: number) => v.toFixed(2) },
            { title: 'CBM', dataIndex: 'cbm', align: 'right' as const, width: 80, render: (v: number) => v.toFixed(3) },
            {
              title: 'Container',
              width: 130,
              render: (_, l) => {
                const c = s.containers.find((x) => x.id === l.containerId);
                return c ? <Tag>{c.containerNo || c.code}</Tag> : <Tag color="orange">loose</Tag>;
              },
            },
          ]}
        />
      </Card>

      <Card size="small" title="Containers">
        {!s.containers.length && <Text type="secondary">No container — a part load.</Text>}
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          {s.containers.map((c) => (
            <Card key={c.id} size="small" type="inner" title={`${c.containerNo || '(not numbered)'} · ${c.code}`} extra={c.sealNo ? <Text type="secondary">Seal {c.sealNo}</Text> : null}>
              <Descriptions size="small" column={{ xs: 1, sm: 3 }}>
                <Descriptions.Item label="Cartons">{c.load.cartons}</Descriptions.Item>
                <Descriptions.Item label="Volume">
                  {c.load.cbm.toFixed(3)} {c.capacityCbm > 0 ? `/ ${c.capacityCbm} CBM` : 'CBM'}
                </Descriptions.Item>
                <Descriptions.Item label="Tare">{(c.tareWeightKg ?? 0).toFixed(0)} kg</Descriptions.Item>
                <Descriptions.Item label="Cargo gross">{c.load.grossKg.toFixed(2)} kg</Descriptions.Item>
                {/* Never stored: tare + derived cargo gross, so it cannot contradict the list. */}
                <Descriptions.Item label="VGM">
                  <b>{c.vgmKg.toFixed(2)} kg</b>
                </Descriptions.Item>
                <Descriptions.Item label="Payload">{c.payloadKg > 0 ? `${c.payloadKg} kg` : '—'}</Descriptions.Item>
              </Descriptions>
              {c.capacityCbm > 0 && (
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  <Progress percent={Math.min(100, c.fit.cbmPct)} status={c.fit.overCbm ? 'exception' : undefined} strokeColor={c.fit.overCbm ? undefined : '#6d4c41'} size="small" format={(p) => `${p?.toFixed(0)}% vol`} />
                  <Progress percent={Math.min(100, c.fit.kgPct)} status={c.fit.overKg ? 'exception' : undefined} strokeColor={c.fit.overKg ? undefined : '#6d4c41'} size="small" format={(p) => `${p?.toFixed(0)}% wt`} />
                </Space>
              )}
            </Card>
          ))}
        </Space>
      </Card>

      <Modal
        open={invoicing}
        title="Raise an invoice"
        onCancel={() => setInvoicing(false)}
        onOk={() => invoice.mutate()}
        okButtonProps={{ disabled: invoiceBuyer == null, loading: invoice.isPending }}
        okText="Raise as draft"
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Text type="secondary">
            An invoice is one buyer's document, and this container may be co-loaded — so pick whose goods to bill. Prices come from the order; nothing is typed.
          </Text>
          <Select
            style={{ width: '100%' }}
            value={invoiceBuyer}
            onChange={setInvoiceBuyer}
            options={[...new Map(s.orders.map((o) => [o.buyerId, { value: o.buyerId, label: o.buyerName }])).values()]}
          />
        </Space>
      </Modal>
    </div>
  );
}
