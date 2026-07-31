import { useEffect, useState } from 'react';
import { App, Breadcrumb, Button, Card, Checkbox, Col, Drawer, InputNumber, Result, Row, Skeleton, Space, Tag, Typography } from 'antd';
import { HomeOutlined, ArrowLeftOutlined, PrinterOutlined, EyeOutlined, FilePdfOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, apiError } from '../../api/client';
import { useSheet, fetchDocument, type OpExplosion } from '../../api/ops';
import { useMeta } from '../../api/hooks';
import { useAuth } from '../../auth/AuthContext';
import { money, num, headColor } from '../../util/format';

const { Title, Text } = Typography;
const HEAD_ORDER = ['MAIN_COMPONENT', 'SUB_COMPONENT', 'HARDWARE', 'POLISHING', 'PACKAGING', 'LABOUR', 'FORWARDING'];

/**
 * A material sheet: the live costing explosion for this product × quantity, so the
 * floor and the store know exactly what to pull. Progress lives on the order board.
 */
export default function SheetDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { can } = useAuth();
  const editable = can('sheets.create');
  const { data: s, isLoading, isError } = useSheet(id);
  const { data: meta } = useMeta();

  const [qty, setQty] = useState(1);
  const [drawerHead, setDrawerHead] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [printHeads, setPrintHeads] = useState<string[]>([]);

  useEffect(() => {
    if (s) setQty(s.qty);
  }, [s]);

  const updateSheet = useMutation({
    mutationFn: (body: any) => api.put(`/operation-sheets/${id}`, body),
    onSuccess: () => {
      message.success('Saved.');
      qc.invalidateQueries({ queryKey: ['op-sheet', id] });
      qc.invalidateQueries({ queryKey: ['op-sheets'] });
    },
    onError: (e) => message.error(apiError(e)),
  });

  if (isLoading) return <Skeleton active paragraph={{ rows: 6 }} />;
  if (isError || !s) return <Result status="404" title="Sheet not found" extra={<Button onClick={() => navigate('/operations/sheets')}>Back</Button>} />;

  const ex = s.explosion;
  const symbol = ex?.currency?.symbol ?? '₹';
  const headLabel = (h: string) => meta?.heads.find((x) => x.code === h)?.label ?? h;
  const presentHeads = HEAD_ORDER.filter((h) => (ex?.groups ?? []).some((g) => g.head === h));

  const doPrint = (heads: string[]) => {
    setPrintHeads(heads);
    setTimeout(() => window.print(), 80);
  };

  const renderSection = (exp: OpExplosion, head: string) => (
    <div key={head} style={{ marginBottom: 16 }}>
      <div className="cost-head-bar" style={{ background: headColor(head), display: 'flex', justifyContent: 'space-between' }}>
        <span>{headLabel(head)}</span>
        <span>{money(exp.order.headTotals[head] ?? 0, symbol)}</span>
      </div>
      {exp.groups
        .filter((g) => g.head === head)
        .map((g) => (
          <Card key={g.name} size="small" style={{ marginTop: 8 }} title={<span>{g.name} <Tag>{g.method}</Tag></span>} extra={<Text strong>{money(g.orderTotal, symbol)}</Text>}>
            <table className="doc-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th style={{ textAlign: 'right' }}>Per pc</th>
                  <th style={{ textAlign: 'right' }}>× {s.qty}</th>
                  <th style={{ textAlign: 'right' }}>Amt/pc</th>
                  <th style={{ textAlign: 'right' }}>Job total</th>
                </tr>
              </thead>
              <tbody>
                {g.lines.map((l, i) => (
                  <tr key={i}>
                    <td>
                      {l.name}
                      {l.unit ? <span style={{ color: '#999' }}> ({l.unit})</span> : ''}
                    </td>
                    <td style={{ textAlign: 'right' }}>{num(l.measure, 3)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{num(l.orderMeasure, 3)}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.amount, symbol)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{money(l.orderAmount, symbol)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ))}
    </div>
  );

  return (
    <div>
      <div className="no-print">
        <Breadcrumb
          style={{ marginBottom: 16 }}
          items={[
            { title: <Link to="/"><HomeOutlined /></Link> },
            { title: <Link to="/operations">Operations</Link> },
            { title: <Link to="/operations/sheets">Material Sheets</Link> },
            { title: s.number },
          ]}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
          <Space wrap>
            <Title level={3} style={{ margin: 0 }}>
              {s.number}
            </Title>
            <Text type="secondary">
              {s.product.factoryCode} · {s.product.name}
            </Text>
            <Tag color="#6d4c41">{s.qty} pcs</Tag>
            {s.order && <Link to={`/operations/orders/${s.order.id}`}><Tag>{s.order.number}</Tag></Link>}
          </Space>
          <Space wrap>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/operations/sheets')}>
              Back
            </Button>
            {s.order && (
              <Button onClick={() => navigate(`/operations/orders/${s.order!.id}`)}>Go to production board</Button>
            )}
            <Button
              icon={<FilePdfOutlined />}
              onClick={() => fetchDocument(`/operation-sheets/${s.id}/pdf`, `${s.number}.pdf`, true).catch((e: unknown) => message.error(apiError(e)))}
            >
              Download PDF
            </Button>
            <Button type="primary" icon={<PrinterOutlined />} onClick={() => doPrint(presentHeads)}>
              Print full sheet
            </Button>
          </Space>
        </div>

        <Card size="small" style={{ marginBottom: 16 }}>
          <Row gutter={[16, 12]} align="middle">
            <Col xs={24} md={8}>
              <Text type="secondary">Sheet quantity</Text>
              {editable ? (
                <Space.Compact style={{ width: '100%' }}>
                  <InputNumber min={1} value={qty} onChange={(v) => setQty(v ?? 1)} style={{ width: '60%' }} />
                  <Button loading={updateSheet.isPending} onClick={() => updateSheet.mutate({ qty })}>
                    Apply
                  </Button>
                </Space.Compact>
              ) : (
                <div>{s.qty}</div>
              )}
            </Col>
            <Col xs={24} md={16} style={{ textAlign: 'right' }}>
              {ex ? (
                <Text type="secondary">
                  Job FOB <b style={{ color: '#4e342e' }}>{money(ex.order.fob, symbol)}</b> · Ex-factory {money(ex.order.exFactory, symbol)} · per pc {money(ex.perPiece.fob, symbol)}
                </Text>
              ) : (
                <Text type="secondary">This product has no active costing sheet to explode.</Text>
              )}
            </Col>
          </Row>
        </Card>

        <Card
          size="small"
          title="Sections"
          extra={selected.length > 0 && (
            <Button type="primary" icon={<PrinterOutlined />} onClick={() => doPrint(selected)}>
              Print selected ({selected.length})
            </Button>
          )}
        >
          {!ex ? (
            <Text type="secondary">Nothing to show — add a costing sheet to the product first.</Text>
          ) : (
            <Row gutter={[12, 12]}>
              {presentHeads.map((h) => (
                <Col key={h} xs={24} sm={12} md={8}>
                  <Card size="small" style={{ borderLeft: `4px solid ${headColor(h)}` }} styles={{ body: { padding: 12 } }}>
                    <Checkbox checked={selected.includes(h)} onChange={(e) => setSelected((prev) => (e.target.checked ? [...prev, h] : prev.filter((x) => x !== h)))}>
                      <b>{headLabel(h)}</b>
                    </Checkbox>
                    <div style={{ margin: '6px 0', fontSize: 16, fontWeight: 600, color: '#4e342e' }}>{money(ex.order.headTotals[h] ?? 0, symbol)}</div>
                    <Space>
                      <Button size="small" icon={<EyeOutlined />} onClick={() => setDrawerHead(h)}>
                        View
                      </Button>
                      <Button size="small" icon={<PrinterOutlined />} onClick={() => doPrint([h])}>
                        Print
                      </Button>
                    </Space>
                  </Card>
                </Col>
              ))}
            </Row>
          )}
        </Card>
      </div>

      <Drawer
        title={drawerHead ? headLabel(drawerHead) : ''}
        open={!!drawerHead}
        onClose={() => setDrawerHead(null)}
        width={620}
        extra={drawerHead && (
          <Button icon={<PrinterOutlined />} onClick={() => doPrint([drawerHead])}>
            Print
          </Button>
        )}
      >
        {ex && drawerHead && renderSection(ex, drawerHead)}
      </Drawer>

      <div className="print-area" style={{ display: printHeads.length ? undefined : 'none' }}>
        <div className="doc-sheet">
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#4e342e' }}>Material Sheet — {s.number}</div>
              <div>
                {s.product.factoryCode} · {s.product.name}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div>
                Qty: <b>{s.qty} pcs</b>
              </div>
              <div style={{ color: '#777' }}>{s.order ? `Order ${s.order.number}` : 'Standalone'}</div>
            </div>
          </div>
          <div style={{ marginTop: 16 }}>{ex && printHeads.map((h) => renderSection(ex, h))}</div>
        </div>
      </div>
    </div>
  );
}
