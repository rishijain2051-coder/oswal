import { useState } from 'react';
import { Alert, App, Breadcrumb, Button, Card, DatePicker, Drawer, Input, Modal, Result, Skeleton, Space, Tag, Typography } from 'antd';
import {
  HomeOutlined,
  ArrowLeftOutlined,
  PrinterOutlined,
  EditOutlined,
  FilePdfOutlined,
  MailOutlined,
  SendOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  RollbackOutlined,
  PaperClipOutlined,
} from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api, apiError } from '../../api/client';
import { fetchDocument, useMailDraft, useProforma, PROFORMA_STATUS_COLOR } from '../../api/ops';
import { useAuth } from '../../auth/AuthContext';
import { money } from '../../util/format';
import DocumentTotalsPanel from '../../components/DocumentTotals';
import { documentTitle } from '../../util/pricing';
import { useCompany } from '../../api/hooks';

const { Title, Text, Paragraph } = Typography;

export default function ProformaDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { can } = useAuth();
  const editable = can('proformas.edit');
  const { data: p, isLoading, isError } = useProforma(id);
  // The letterhead comes from the Company record, so the printed page and the PDF that
  // goes to the buyer cannot say different things.
  const { data: company } = useCompany();

  const [sendOpen, setSendOpen] = useState(false);
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [deliveryDate, setDeliveryDate] = useState<dayjs.Dayjs | null>(null);
  const [reason, setReason] = useState('');
  const { data: mail } = useMailDraft(id, sendOpen);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['proforma', id] });
    qc.invalidateQueries({ queryKey: ['proformas'] });
    qc.invalidateQueries({ queryKey: ['ops-dashboard'] });
  };

  const markSent = useMutation({
    mutationFn: () => api.post(`/proformas/${id}/send`, {}),
    onSuccess: () => {
      message.success('Marked as Sent.');
      refresh();
    },
    onError: (e) => message.error(apiError(e)),
  });

  const reopen = useMutation({
    mutationFn: () => api.post(`/proformas/${id}/reopen`, {}),
    onSuccess: () => {
      message.success('Back to Draft — edit and send again.');
      refresh();
    },
    onError: (e) => message.error(apiError(e)),
  });

  const accept = useMutation({
    mutationFn: () => api.post(`/proformas/${id}/accept`, { deliveryDate: deliveryDate ? deliveryDate.toISOString() : null }),
    onSuccess: (res) => {
      const { order, skippedLines } = res.data as any;
      setAcceptOpen(false);
      message.success(`Accepted — order ${order.number} created.`);
      if (skippedLines > 0) message.warning(`${skippedLines} line(s) had no linked product and were left out of the order.`);
      qc.invalidateQueries({ queryKey: ['orders'] });
      refresh();
      navigate(`/operations/orders/${order.id}`);
    },
    onError: (e) => message.error(apiError(e)),
  });

  const reject = useMutation({
    mutationFn: () => api.post(`/proformas/${id}/reject`, { reason: reason.trim() || null }),
    onSuccess: () => {
      setRejectOpen(false);
      setReason('');
      message.success('Marked as Rejected. Nothing else happens.');
      refresh();
    },
    onError: (e) => message.error(apiError(e)),
  });

  if (isLoading) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (isError || !p) return <Result status="404" title="Proforma not found" extra={<Button onClick={() => navigate('/operations/proformas')}>Back</Button>} />;

  const symbol = p.currency?.symbol ?? '₹';
  const showImages = p.showImages && p.lines.some((l) => l.image);

  const downloadPdf = () => fetchDocument(`/proformas/${p.id}/pdf`, `${p.number}.pdf`, true).catch((e) => message.error(e.message));

  const openMailDraft = async () => {
    try {
      await fetchDocument(`/proformas/${p.id}/email.eml`, `${p.number}.eml`);
      message.success('Draft downloaded — open it to launch your mail app with the PDF attached.');
      if (p.status === 'Draft') markSent.mutate();
    } catch (e: any) {
      message.error(e.message);
    }
  };

  const openMailto = () => {
    if (!mail?.mailto) return;
    window.location.href = mail.mailto;
    if (p.status === 'Draft') markSent.mutate();
  };

  return (
    <div>
      <div className="no-print">
        <Breadcrumb
          style={{ marginBottom: 16 }}
          items={[
            { title: <Link to="/"><HomeOutlined /></Link> },
            { title: <Link to="/operations">Operations</Link> },
            { title: <Link to="/operations/proformas">Proformas</Link> },
            { title: p.number },
          ]}
        />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
          <Space wrap>
            <Title level={3} style={{ margin: 0 }}>
              {p.number}
            </Title>
            <Tag color={PROFORMA_STATUS_COLOR[p.status] ?? 'default'}>{p.status}</Tag>
            {p.order && (
              <Link to={`/operations/orders/${p.order.id}`}>
                <Tag color="green">Order {p.order.number}</Tag>
              </Link>
            )}
            <Text type="secondary">{p.buyer.name}</Text>
          </Space>
          <Space wrap>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/operations/proformas')}>
              Back
            </Button>
            <Button icon={<FilePdfOutlined />} onClick={downloadPdf}>
              PDF
            </Button>
            <Button icon={<PrinterOutlined />} onClick={() => window.print()}>
              Print
            </Button>
            {editable && p.canEdit && (
              <Button icon={<EditOutlined />} onClick={() => navigate(`/operations/proformas/${p.id}/edit`)}>
                Edit
              </Button>
            )}
            {editable && !p.order && (
              <Button type="primary" icon={<MailOutlined />} onClick={() => setSendOpen(true)}>
                Send to buyer
              </Button>
            )}
          </Space>
        </div>

        {/* WHERE THIS PI STANDS — and the one decision that matters */}
        <Card size="small" style={{ marginBottom: 16 }}>
          {p.status === 'Draft' && (
            <Space wrap>
              <Text type="secondary">Draft — nothing sent yet.</Text>
              {editable && (
                <Button size="small" icon={<SendOutlined />} onClick={() => setSendOpen(true)}>
                  Send it
                </Button>
              )}
            </Space>
          )}

          {p.status === 'Sent' && (
            <Space wrap size={12}>
              <Text>
                Sent {p.sentAt ? dayjs(p.sentAt).format('DD MMM YYYY') : ''} — waiting on the buyer.
              </Text>
              {editable && (
                <>
                  <Button type="primary" icon={<CheckCircleOutlined />} onClick={() => setAcceptOpen(true)}>
                    Buyer accepted
                  </Button>
                  <Button danger icon={<CloseCircleOutlined />} onClick={() => setRejectOpen(true)}>
                    Buyer rejected
                  </Button>
                  <Button size="small" type="text" icon={<RollbackOutlined />} onClick={() => reopen.mutate()} loading={reopen.isPending}>
                    Back to draft
                  </Button>
                </>
              )}
            </Space>
          )}

          {p.status === 'Accepted' && (
            <Space wrap>
              <Text type="success">
                Accepted {p.decidedAt ? dayjs(p.decidedAt).format('DD MMM YYYY') : ''}.
              </Text>
              {p.order ? (
                <Button size="small" type="primary" ghost onClick={() => navigate(`/operations/orders/${p.order!.id}`)}>
                  Open order {p.order.number}
                </Button>
              ) : null}
            </Space>
          )}

          {p.status === 'Rejected' && (
            <Space wrap>
              <Text type="danger">Rejected {p.decidedAt ? dayjs(p.decidedAt).format('DD MMM YYYY') : ''}.</Text>
              {p.rejectReason && <Text type="secondary">Reason: {p.rejectReason}</Text>}
              {editable && (
                <Button size="small" icon={<RollbackOutlined />} onClick={() => reopen.mutate()} loading={reopen.isPending}>
                  Revise & re-send
                </Button>
              )}
            </Space>
          )}
        </Card>
      </div>

      {/* THE DOCUMENT */}
      <div className="print-area">
        <div className="doc-sheet">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              {company?.logoFilename && <img src={`/uploads/${company.logoFilename}`} alt="" style={{ width: 54, height: 54, objectFit: 'contain' }} />}
              <div>
                {/* From the Company record, so this page and the PDF cannot disagree. */}
                <div style={{ fontSize: 22, fontWeight: 700, color: '#4e342e' }}>{company?.legalName ?? 'Oswal Handicrafts'}</div>
                <div style={{ color: '#777', fontSize: 12 }}>
                  {[company?.tradeName, [company?.city, company?.state].filter(Boolean).join(', '), company?.country].filter(Boolean).join(' · ')}
                </div>
                {company?.gstNo && <div style={{ color: '#777', fontSize: 12 }}>GSTIN: {company.gstNo}</div>}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              {/* A domestic document is a Quotation, not a Proforma Invoice — the same
                  string the PDF and the e-mail use. */}
              <div style={{ fontSize: 18, fontWeight: 700 }}>{documentTitle(p.taxMarket ?? p.buyer.market)}</div>
              <div>{p.number}</div>
              <div style={{ color: '#777' }}>{dayjs(p.date).format('DD MMM YYYY')}</div>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20, gap: 24 }}>
            <div>
              <div style={{ color: '#777', fontSize: 12 }}>BUYER</div>
              <div style={{ fontWeight: 600 }}>{p.buyer.name}</div>
              {p.buyer.contactName && <div style={{ fontSize: 12 }}>Attn: {p.buyer.contactName}</div>}
              {p.buyer.address && <div style={{ fontSize: 12, whiteSpace: 'pre-line' }}>{p.buyer.address}</div>}
              {p.buyer.country && <div style={{ fontSize: 12 }}>{p.buyer.country}</div>}
              {p.buyer.email && <div style={{ fontSize: 12 }}>{p.buyer.email}</div>}
              {/* A GST document has to state the buyer's registration. */}
              {p.buyer.gstNo && <div style={{ fontSize: 12 }}>GSTIN: {p.buyer.gstNo}</div>}
            </div>
            <div style={{ textAlign: 'right', fontSize: 12 }}>
              {p.incoterms && (
                <div>
                  <b>Incoterms:</b> {p.incoterms}
                </div>
              )}
              {/* Place of supply is what justifies the CGST/SGST versus IGST choice. */}
              {p.totals?.taxed && (
                <div>
                  <b>Place of supply:</b> {p.taxBuyerState ?? p.buyer.state ?? '—'}
                </div>
              )}
              {p.validUntil && (
                <div>
                  <b>Valid until:</b> {dayjs(p.validUntil).format('DD MMM YYYY')}
                </div>
              )}
              <div>
                <b>Currency:</b> {p.currency?.code ?? 'INR'}
              </div>
            </div>
          </div>

          <table className="doc-table">
            <thead>
              <tr>
                <th style={{ width: 34 }}>#</th>
                {showImages && <th style={{ width: 74 }} />}
                <th>Description</th>
                {p.totals?.taxed && <th style={{ width: 62 }}>HSN</th>}
                <th style={{ width: 60, textAlign: 'right' }}>Qty</th>
                <th style={{ width: 100, textAlign: 'right' }}>Unit Price</th>
                {p.totals?.taxed && <th style={{ width: 54, textAlign: 'right' }}>GST</th>}
                <th style={{ width: 110, textAlign: 'right' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {p.lines.map((l, i) => (
                <tr key={l.id ?? i}>
                  <td>{i + 1}</td>
                  {showImages && <td>{l.image ? <img src={l.image.url} alt="" className="doc-thumb" /> : null}</td>}
                  <td>
                    <div>{l.description}</div>
                    {l.product && <div style={{ color: '#999', fontSize: 12 }}>{l.product.factoryCode}</div>}
                    {l.specs && <div style={{ color: '#999', fontSize: 12 }}>{l.specs}</div>}
                    {/* A discount is stated on its own line, or the amount looks wrong. */}
                    {((l.discountPct ?? 0) > 0 || (l.discountAmt ?? 0) > 0) && (
                      <div style={{ color: '#c62828', fontSize: 12 }}>
                        {[(l.discountPct ?? 0) > 0 ? `${l.discountPct}% off` : '', (l.discountAmt ?? 0) > 0 ? `less ${money(l.discountAmt!, symbol)}` : ''].filter(Boolean).join(', ')}
                      </div>
                    )}
                  </td>
                  {p.totals?.taxed && <td style={{ fontSize: 12, color: '#666' }}>{l.hsnCode ?? '—'}</td>}
                  <td style={{ textAlign: 'right' }}>{l.qty}</td>
                  <td style={{ textAlign: 'right' }}>{money(l.unitPrice, symbol)}</td>
                  {p.totals?.taxed && <td style={{ textAlign: 'right', fontSize: 12 }}>{l.gstRatePct ?? 0}%</td>}
                  <td style={{ textAlign: 'right' }}>{money(l.amount ?? l.qty * l.unitPrice, symbol)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Subtotal, charges and the tax split — all from the pricing engine. */}
          <div style={{ marginTop: 12 }}>
            <DocumentTotalsPanel totals={p.totals} symbol={symbol} />
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20, gap: 24, fontSize: 12 }}>
            <div style={{ maxWidth: '55%' }}>
              {p.paymentTerms && (
                <div>
                  <b>Payment:</b> {p.paymentTerms}
                </div>
              )}
              {p.deliveryTerms && (
                <div>
                  <b>Delivery:</b> {p.deliveryTerms}
                </div>
              )}
              {p.notes && <div style={{ marginTop: 8, whiteSpace: 'pre-line' }}>{p.notes}</div>}
            </div>
            {p.bankDetails && (
              <div style={{ whiteSpace: 'pre-line', textAlign: 'right' }}>
                <div style={{ color: '#777' }}>BANK DETAILS</div>
                {p.bankDetails}
              </div>
            )}
          </div>
          <div style={{ marginTop: 28, textAlign: 'right', fontSize: 12 }}>
            <div style={{ marginTop: 30 }}>For Oswal Handicrafts</div>
            <div style={{ color: '#777' }}>Authorised Signatory</div>
          </div>
        </div>
      </div>

      {/* SEND */}
      <Drawer open={sendOpen} onClose={() => setSendOpen(false)} width={560} title={`Send ${p.number} to ${p.buyer.name}`}>
        {!mail ? (
          <Skeleton active />
        ) : !mail.hasEmail ? (
          <Alert
            type="warning"
            showIcon
            message="This buyer has no e-mail address"
            description={
              <span>
                Add one in <Link to="/settings/masters">Master Data → Buyers</Link>, then come back. You can still download the PDF and send it yourself.
              </span>
            }
            action={
              <Button size="small" icon={<FilePdfOutlined />} onClick={downloadPdf}>
                PDF
              </Button>
            }
          />
        ) : (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <div>
              <Text type="secondary">To</Text>
              <div>
                <Text strong>{mail.to.join(', ')}</Text>
                {mail.contactName && <Text type="secondary"> · {mail.contactName}</Text>}
              </div>
            </div>
            <div>
              <Text type="secondary">Subject</Text>
              <Input readOnly value={mail.subject} />
            </div>
            <div>
              <Text type="secondary">Body</Text>
              <Input.TextArea readOnly value={mail.text} autoSize={{ minRows: 8, maxRows: 14 }} style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }} />
            </div>

            <Button type="primary" block size="large" icon={<PaperClipOutlined />} onClick={openMailDraft}>
              Open mail draft with the PDF attached
            </Button>
            <Text type="secondary" style={{ fontSize: 12, marginTop: -10 }}>
              Downloads <b>{p.number}.eml</b>. Open it and your mail app (Outlook / Windows Mail) shows a ready draft — recipient, subject, body and the PI PDF already attached. Press Send there.
            </Text>

            <Button block icon={<MailOutlined />} onClick={openMailto}>
              Open mail app without attachment
            </Button>
            <Button block icon={<FilePdfOutlined />} onClick={downloadPdf}>
              Just show me the PDF
            </Button>

            <Alert
              type="info"
              showIcon
              message="Why two buttons?"
              description="A plain mail link (mailto:) can carry the subject and body but never a file — no mail client accepts an attachment that way. The .eml draft is the way to get the PDF attached automatically."
            />

            {p.status === 'Draft' && (
              <Button block type="text" icon={<SendOutlined />} loading={markSent.isPending} onClick={() => markSent.mutate()}>
                Just mark it as Sent
              </Button>
            )}
          </Space>
        )}
      </Drawer>

      {/* ACCEPT — the prompt that creates an order */}
      <Modal
        open={acceptOpen}
        onCancel={() => setAcceptOpen(false)}
        onOk={() => accept.mutate()}
        confirmLoading={accept.isPending}
        okText="Yes, create the order"
        cancelText="Cancel — keep it at Sent"
        okButtonProps={{ icon: <CheckCircleOutlined /> }}
        title="Accepting this proforma will create an order"
      >
        <Paragraph>
          A confirmed order will be created from <b>{p.number}</b> for <b>{p.buyer.name}</b> — {p.lines.length} line(s), {money(p.total, symbol)}. Every line gets its production stages ready so
          you can start moving pieces.
        </Paragraph>
        <Paragraph type="secondary" style={{ marginBottom: 8 }}>
          This proforma then becomes read-only. Are you sure?
        </Paragraph>
        <Text type="secondary">Delivery date (optional)</Text>
        <DatePicker style={{ width: '100%' }} value={deliveryDate} onChange={setDeliveryDate} />
      </Modal>

      {/* REJECT — records it and stops */}
      <Modal
        open={rejectOpen}
        onCancel={() => setRejectOpen(false)}
        onOk={() => reject.mutate()}
        confirmLoading={reject.isPending}
        okText="Mark as rejected"
        okButtonProps={{ danger: true, icon: <CloseCircleOutlined /> }}
        title={`Buyer rejected ${p.number}?`}
      >
        <Paragraph type="secondary">Nothing else happens — no order is created. You can revise and re-send it later.</Paragraph>
        <Text type="secondary">Reason (optional)</Text>
        <Input.TextArea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. price too high, wants FOB Nhava Sheva" />
      </Modal>
    </div>
  );
}
