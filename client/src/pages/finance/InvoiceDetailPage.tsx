import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Breadcrumb, Button, Card, DatePicker, Descriptions, Image, Input, Popconfirm, Result, Space, Spin, Table, Tag, Typography, Upload } from 'antd';
import { FilePdfOutlined, HomeOutlined, MailOutlined, UploadOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import {
  invalidateSales,
  invoiceEml,
  invoicePdf,
  INVOICE_STATUS_COLOR,
  setInvoiceStatus,
  updateInvoice,
  uploadInvoiceQr,
  useInvoice,
} from '../../api/sales';
import type { DocCharge } from '../../api/ops';
import { apiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import DocumentTotals from '../../components/DocumentTotals';
import ChargesEditor from '../../components/ChargesEditor';
import { money } from '../../util/format';

const { Title, Text } = Typography;

export default function InvoiceDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { hasRole } = useAuth();
  const { data: inv, isLoading, error } = useInvoice(id);

  const [charges, setCharges] = useState<DocCharge[]>([]);
  const [terms, setTerms] = useState('');
  const [bank, setBank] = useState('');
  const [notes, setNotes] = useState('');
  const [irn, setIrn] = useState('');
  const [ackNo, setAckNo] = useState('');
  const [dueDate, setDueDate] = useState<Dayjs | null>(null);

  useEffect(() => {
    if (!inv) return;
    setCharges(inv.charges as DocCharge[]);
    setTerms(inv.paymentTerms ?? '');
    setBank(inv.bankDetails ?? '');
    setNotes(inv.notes ?? '');
    setIrn(inv.irn ?? '');
    setAckNo(inv.ackNo ?? '');
    setDueDate(inv.dueDate ? dayjs(inv.dueDate) : null);
  }, [inv]);

  /**
   * EVERY hook runs before the early returns below. React counts hooks by position, so a
   * `useMutation` after a conditional `return` changes the order between the loading render
   * and the loaded one and white-screens the page.
   */
  const save = useMutation({
    mutationFn: () =>
      updateInvoice(inv!.id, {
        charges,
        paymentTerms: terms || null,
        bankDetails: bank || null,
        notes: notes || null,
        irn: irn || null,
        ackNo: ackNo || null,
        dueDate: dueDate ? dueDate.toISOString() : null,
      }),
    onSuccess: () => {
      message.success('Saved.');
      invalidateSales(qc);
    },
    onError: (e) => message.error(apiError(e)),
  });

  const setStatus = useMutation({
    mutationFn: (s: string) => setInvoiceStatus(inv!.id, s),
    onSuccess: (r: { status: string }) => {
      message.success(r.status === 'ISSUED' ? 'Issued — it is now a receivable.' : `Marked ${r.status.toLowerCase()}.`);
      invalidateSales(qc);
    },
    onError: (e) => message.error(apiError(e)),
  });

  const qr = useMutation({
    mutationFn: (f: File) => uploadInvoiceQr(inv!.id, f),
    onSuccess: () => {
      message.success('QR uploaded.');
      invalidateSales(qc);
    },
    onError: (e) => message.error(apiError(e)),
  });

  if (!hasRole('Manager')) return <Result status="403" title="Manager access" />;
  if (isLoading) return <Spin />;
  // As on the shipment page: an error must say so, not spin.
  if (error || !inv) return <Result status="404" title="Invoice not found" subTitle={error ? apiError(error) : 'It may have been deleted.'} />;

  const symbol = inv.currency?.symbol ?? '₹';
  const domestic = (inv.taxMarket ?? inv.buyer.market) === 'DOMESTIC';
  const editable = inv.status !== 'CANCELLED';

  const doc = (fn: () => Promise<void>) => () => fn().catch((e) => message.error(apiError(e)));

  return (
    <div>
      <Breadcrumb
        style={{ marginBottom: 12 }}
        items={[
          { title: <Link to="/"><HomeOutlined /></Link> },
          { title: <Link to="/finance">Finance</Link> },
          { title: <Link to="/finance/invoices">Invoices</Link> },
          { title: inv.number },
        ]}
      />
      <Space style={{ justifyContent: 'space-between', width: '100%', marginBottom: 12 }} align="start">
        <Space align="center">
          <Title level={4} style={{ margin: 0 }}>
            {inv.number}
          </Title>
          <Tag color={INVOICE_STATUS_COLOR[inv.status]}>{inv.status}</Tag>
          <Tag color={domestic ? 'gold' : 'cyan'}>{domestic ? 'Tax invoice' : 'Commercial invoice'}</Tag>
        </Space>
        <Space wrap>
          <Button size="small" icon={<FilePdfOutlined />} onClick={doc(() => invoicePdf(inv))}>
            PDF
          </Button>
          <Button size="small" icon={<MailOutlined />} onClick={doc(() => invoiceEml(inv))}>
            E-mail draft
          </Button>
          {inv.status === 'DRAFT' && (
            <Popconfirm title="Issue this invoice?" description="It becomes a receivable from this moment." onConfirm={() => setStatus.mutate('ISSUED')}>
              <Button size="small" type="primary" loading={setStatus.isPending}>
                Issue
              </Button>
            </Popconfirm>
          )}
          {inv.status === 'ISSUED' && (
            <Popconfirm
              title="Cancel this invoice?"
              description="Its number is kept — a gap in an invoice series is a compliance problem — and it leaves every money total."
              onConfirm={() => setStatus.mutate('CANCELLED')}
            >
              <Button size="small" danger loading={setStatus.isPending}>
                Cancel invoice
              </Button>
            </Popconfirm>
          )}
        </Space>
      </Space>

      {inv.status === 'DRAFT' && <Alert type="info" showIcon style={{ marginBottom: 12 }} message="A draft is not yet a receivable. Issue it when it goes to the buyer." />}

      <Card size="small" style={{ marginBottom: 12 }}>
        <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }}>
          <Descriptions.Item label="Buyer">{inv.buyer.name}</Descriptions.Item>
          <Descriptions.Item label="Date">{dayjs(inv.invoiceDate).format('DD MMM YYYY')}</Descriptions.Item>
          <Descriptions.Item label="Currency">{inv.currency?.code ?? 'INR'}</Descriptions.Item>
          <Descriptions.Item label="Shipment">
            {inv.shipment ? <Link to={`/sales/shipments/${inv.shipment.id}`}>{inv.shipment.number}</Link> : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Orders">
            <Space size={2} wrap>
              {inv.orders.map((o) => (
                <Link key={o.orderId} to={`/operations/orders/${o.orderId}`}>
                  <Tag>{o.number}</Tag>
                </Link>
              ))}
            </Space>
          </Descriptions.Item>
          {!domestic && <Descriptions.Item label="Incoterms">{inv.incoterms ?? '—'}</Descriptions.Item>}
          {domestic && <Descriptions.Item label="Place of supply">{inv.placeOfSupply ?? '—'}</Descriptions.Item>}
          {domestic && <Descriptions.Item label="Reverse charge">{inv.reverseCharge ? 'Yes' : 'No'}</Descriptions.Item>}
          {/* The frozen basis, so it is visible that the document cannot be restated. */}
          <Descriptions.Item label="Tax basis (frozen)">
            {inv.taxMarket ?? '—'}
            {inv.taxBuyerState ? ` · ${inv.taxBuyerState}` : ''}
            {inv.taxCompanyState ? ` → ${inv.taxCompanyState}` : ''}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card size="small" title="Lines" style={{ marginBottom: 12 }}>
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={inv.lines}
          columns={[
            { title: 'Product', render: (_, l) => `${l.productCode} — ${l.productName}` },
            { title: 'Order', render: (_, l) => (l.orderId ? <Link to={`/operations/orders/${l.orderId}`}>{l.orderNumber}</Link> : '—') },
            ...(domestic ? [{ title: 'HSN', dataIndex: 'hsnCode', width: 80 }] : []),
            { title: 'Qty', dataIndex: 'qty', align: 'right' as const, width: 70 },
            { title: 'Unit', dataIndex: 'unit', width: 60 },
            // Every money cell is TEXT. That is the visible enforcement of the rule that
            // quantities come from the shipment and prices from the order.
            { title: 'Rate', align: 'right' as const, width: 110, render: (_, l) => money(l.unitPrice, symbol) },
            ...(domestic ? [{ title: 'GST', align: 'right' as const, width: 70, render: (_: unknown, l: { gstRatePct: number }) => `${l.gstRatePct}%` }] : []),
            {
              title: 'Amount',
              align: 'right' as const,
              width: 120,
              render: (_, l) => <b>{money(Math.max(0, l.qty * l.unitPrice * (1 - l.discountPct / 100) - l.discountAmt), symbol)}</b>,
            },
          ]}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          Quantities come from the shipment and prices from the order. Nothing here is typed — to change a price, edit the order.
        </Text>
        <div style={{ marginTop: 12 }}>
          <DocumentTotals totals={inv.totals} symbol={symbol} />
        </div>
      </Card>

      {editable && (
        <Card
          size="small"
          title="Charges and terms"
          style={{ marginBottom: 12 }}
          extra={
            <Button size="small" type="primary" loading={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          }
        >
          <Text type="secondary" style={{ fontSize: 12 }}>
            Freight and insurance are what turn an FOB price into CFR or CIF. They belong to the whole document, not to a line.
          </Text>
          <div style={{ marginTop: 8 }}>
            <ChargesEditor charges={charges} subtotal={inv.totals.subtotal} symbol={symbol} taxed={inv.totals.taxed} defaultGstPct={18} onChange={setCharges} />
          </div>
          <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 12 }}>
            <Space wrap>
              <div>
                <Text type="secondary">Due date</Text>
                <DatePicker style={{ width: 180, display: 'block' }} value={dueDate} onChange={setDueDate} format="DD MMM YYYY" />
              </div>
              <div>
                <Text type="secondary">Payment terms</Text>
                <Input style={{ width: 260 }} value={terms} onChange={(e) => setTerms(e.target.value)} />
              </div>
            </Space>
            <div>
              <Text type="secondary">Bank details</Text>
              <Input.TextArea rows={2} value={bank} onChange={(e) => setBank(e.target.value)} />
            </div>
            <div>
              <Text type="secondary">Notes</Text>
              <Input.TextArea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </Space>
        </Card>
      )}

      {/* Domestic compliance only. Hidden on an export, exactly as Incoterms are for domestic. */}
      {domestic && editable && (
        <Card size="small" title="E-invoice">
          <Space wrap align="start">
            <div>
              <Text type="secondary">IRN</Text>
              <Input style={{ width: 320 }} value={irn} onChange={(e) => setIrn(e.target.value)} />
            </div>
            <div>
              <Text type="secondary">Acknowledgement no.</Text>
              <Input style={{ width: 180 }} value={ackNo} onChange={(e) => setAckNo(e.target.value)} />
            </div>
            <div>
              <Text type="secondary" style={{ display: 'block' }}>
                QR image
              </Text>
              <Upload
                accept=".png,.jpg,.jpeg"
                showUploadList={false}
                beforeUpload={(file, fileList) => {
                  // rc-upload calls this once per file and hands over the whole list each
                  // time; only act on the last, or one drop posts N times.
                  if (file === fileList[fileList.length - 1]) qr.mutate(file as unknown as File);
                  return false;
                }}
              >
                <Button size="small" icon={<UploadOutlined />} loading={qr.isPending}>
                  Upload
                </Button>
              </Upload>
              {inv.qrUrl && <Image src={inv.qrUrl} width={90} style={{ marginTop: 6 }} />}
            </div>
          </Space>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
            Generated on the portal and recorded here — there is no integration, exactly as the customs exchange rates are pasted.
          </Text>
        </Card>
      )}
    </div>
  );
}
