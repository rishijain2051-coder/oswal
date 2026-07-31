import { Button, Card, Col, Divider, Empty, Input, InputNumber, Row, Select, Space, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useCurrencies, useMeta } from '../../../api/hooks';
import { useStageLines } from '../../../api/ops';
import { useAppSettings, useCostLineSuggestions, type Suggestion } from '../../../api/suggest';
import HistoryHint from '../../../components/HistoryHint';
import { groupTotal, lineAmount, lineMeasure, rollup, suggestCostDim } from '../../../util/costing';
import { money, num, headColor } from '../../../util/format';
import type { CostGroup, CostLine } from '../../../api/types';
import type { WizardDraft } from './draft';

const { Text, Title } = Typography;

const HEAD_ORDER = ['MAIN_COMPONENT', 'SUB_COMPONENT', 'HARDWARE', 'POLISHING', 'PACKAGING', 'LABOUR', 'FORWARDING'];

function blankLine(): CostLine {
  return { name: '', qty: 1, wastagePct: 0, rate: 0, unit: null, actualL: null, actualW: null, actualH: null, costL: null, costW: null, costH: null, actualWeight: null };
}

interface ColSpec {
  key: string;
  label: string;
  width: number;
  kind: 'text' | 'number' | 'measure' | 'amount' | 'del' | 'stage' | 'history';
  step?: number;
}

export default function StepCosting({ draft, set, productId }: { draft: WizardDraft; set: (patch: Partial<WizardDraft>) => void; productId?: number }) {
  const { data: meta } = useMeta();
  const { data: currencies } = useCurrencies();
  const { data: stageLines } = useStageLines();
  const cs = draft.costSheet;
  const groups = cs.groups;

  /**
   * The stages this product travels through, offered against each LABOUR line.
   * Mapping is only possible once the product has a stage line, because an order
   * snapshots the steps of that line and looks the rate up by step.
   */
  const stageSteps = (stageLines ?? []).find((l) => l.id === draft.stageLineId)?.steps ?? [];

  // --- what these lines have cost before ----------------------------------
  //
  // One request for the whole sheet: forty fields asking individually would be forty
  // round-trips. Keyed on the line name, so the answer follows a line as it is renamed.
  const { data: appSettings } = useAppSettings();
  const askable = groups.flatMap((g) => g.lines.filter((l) => (l.name ?? '').trim()).map((l) => ({ name: l.name, groupName: g.name, head: g.head, stageStepId: l.stageStepId ?? null })));
  const { data: history, isFetching: historyLoading } = useCostLineSuggestions(productId ?? null, askable);
  const suggestionFor = (name: string): Suggestion | null => {
    const key = (name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    return history?.suggestions.find((s) => s.key === key) ?? null;
  };
  const outlierPct = appSettings?.outlierPct ?? history?.outlierPct ?? 25;
  const windowDays = appSettings?.suggestionWindowDays ?? history?.windowDays ?? 365;

  const methodDef = (code: string) => meta?.methods.find((m) => m.code === code);
  const methodMap = Object.fromEntries((meta?.methods ?? []).map((m) => [m.code, m]));
  const headLabel = (h: string) => meta?.heads.find((x) => x.code === h)?.label ?? h;
  const currency = currencies?.find((c) => c.id === cs.currencyId);
  const symbol = currency?.symbol ?? '₹';

  const summary = rollup(groups, methodMap, cs.factoryExpensePct, cs.marginPct);

  const setSheet = (patch: Partial<WizardDraft['costSheet']>) => set({ costSheet: { ...cs, ...patch } });
  const setGroups = (g: CostGroup[]) => setSheet({ groups: g });

  const addGroup = () =>
    setGroups([...groups, { head: 'MAIN_COMPONENT', name: '', method: 'QTY', dimUnit: 'IN', sortOrder: groups.length, lines: [blankLine()] }]);

  const updateGroup = (gi: number, patch: Partial<CostGroup>) => {
    const g = [...groups];
    g[gi] = { ...g[gi], ...patch };
    setGroups(g);
  };

  const updateLine = (gi: number, li: number, patch: Partial<CostLine>) => {
    const g = [...groups];
    const lines = [...g[gi].lines];
    let line = { ...lines[li], ...patch };
    const def = methodDef(g[gi].method);
    if (def && !def.usesWeight && def.dims.length) {
      const map: [keyof CostLine, keyof CostLine][] = [
        ['actualL', 'costL'],
        ['actualW', 'costW'],
        ['actualH', 'costH'],
      ];
      for (const [aKey, cKey] of map) {
        if ((aKey in patch || 'wastagePct' in patch) && (line[cKey] == null || line[cKey] === undefined)) {
          if (line[aKey] != null) (line as any)[cKey] = suggestCostDim(line[aKey] as number, line.wastagePct);
        }
      }
    }
    lines[li] = line;
    g[gi] = { ...g[gi], lines };
    setGroups(g);
  };

  const applyWastage = (gi: number) => {
    const g = [...groups];
    g[gi] = {
      ...g[gi],
      lines: g[gi].lines.map((l) => ({
        ...l,
        costL: l.actualL != null ? suggestCostDim(l.actualL, l.wastagePct) : l.costL,
        costW: l.actualW != null ? suggestCostDim(l.actualW, l.wastagePct) : l.costW,
        costH: l.actualH != null ? suggestCostDim(l.actualH, l.wastagePct) : l.costH,
      })),
    };
    setGroups(g);
  };

  // Build the column layout for a method (drives both the header labels and rows).
  const columnsFor = (method: string, head?: string): ColSpec[] => {
    const def = methodDef(method);
    const showDims = def && !def.usesWeight && def.dims.length > 0;
    const cols: ColSpec[] = [{ key: 'name', label: 'Item name', width: 150, kind: 'text' }];
    if (showDims) def!.dims.forEach((d) => cols.push({ key: `actual${d}`, label: `Actual ${d}`, width: 66, kind: 'number', step: 0.1 }));
    cols.push({ key: 'qty', label: 'Qty', width: 60, kind: 'number', step: 1 });
    if (def?.usesWastage) cols.push({ key: 'wastagePct', label: 'Wastage %', width: 72, kind: 'number', step: 1 });
    if (def?.usesWeight) cols.push({ key: 'actualWeight', label: 'Weight (kg)', width: 84, kind: 'number', step: 0.01 });
    if (showDims) def!.dims.forEach((d) => cols.push({ key: `cost${d}`, label: `Costing ${d}`, width: 70, kind: 'number', step: 0.1 }));
    if (method === 'QTY') cols.push({ key: 'unit', label: 'Unit', width: 66, kind: 'text' });
    cols.push({ key: 'rate', label: `Rate / ${def?.measureUnit ?? 'unit'}`, width: 90, kind: 'number', step: 0.01 });
    cols.push({ key: 'history', label: 'Before', width: 40, kind: 'history' });
    cols.push({ key: 'measure', label: `Measure (${def?.measureUnit ?? ''})`, width: 78, kind: 'measure' });
    cols.push({ key: 'amount', label: 'Amount', width: 96, kind: 'amount' });
    // Labour is the one head whose lines map onto the production line, so an order can
    // start its in-house piece rates from what the product was costed at.
    if (head === 'LABOUR') cols.push({ key: 'stageStepId', label: 'Pays for stage', width: 150, kind: 'stage' });
    cols.push({ key: 'del', label: '', width: 34, kind: 'del' });
    return cols;
  };

  const renderCell = (col: ColSpec, g: CostGroup, gi: number, li: number, line: CostLine) => {
    const w = col.width;
    if (col.kind === 'text') {
      return (
        <Input
          size="small"
          style={{ width: w }}
          placeholder={col.key === 'name' ? 'name' : ''}
          value={(line[col.key as keyof CostLine] as string) ?? ''}
          onChange={(e) => updateLine(gi, li, { [col.key]: e.target.value } as Partial<CostLine>)}
        />
      );
    }
    if (col.kind === 'number') {
      return (
        <InputNumber
          size="small"
          style={{ width: w }}
          step={col.step}
          value={(line[col.key as keyof CostLine] as number) ?? undefined}
          onChange={(v) => updateLine(gi, li, { [col.key]: v ?? (col.key === 'qty' ? 0 : null) } as Partial<CostLine>)}
        />
      );
    }
    if (col.kind === 'history') {
      return (
        <div style={{ width: w, textAlign: 'center' }}>
          <HistoryHint
            compact
            loading={historyLoading}
            suggestion={suggestionFor(line.name)}
            value={line.rate}
            outlierPct={outlierPct}
            windowDays={windowDays}
            symbol={symbol}
            /* The line's own unit if it has one — a labour line is priced per LOT,
               not per the method's generic measure. */
            unitSuffix={`/${line.unit || methodDef(g.method)?.measureUnit || 'unit'}`}
            onApply={(v) => updateLine(gi, li, { rate: v })}
          />
        </div>
      );
    }
    if (col.kind === 'stage') {
      return (
        <Select
          size="small"
          style={{ width: w }}
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder={stageSteps.length ? 'not mapped' : 'no stage line'}
          disabled={stageSteps.length === 0}
          value={line.stageStepId ?? undefined}
          onChange={(v) => updateLine(gi, li, { stageStepId: v ?? null })}
          options={stageSteps.map((st) => ({ value: st.id, label: `${st.sortOrder + 1}. ${st.name}` }))}
        />
      );
    }
    if (col.kind === 'measure') return <span style={{ width: w, display: 'inline-block', textAlign: 'right', fontSize: 12, color: '#8c8c8c' }}>{num(lineMeasure(methodMap[g.method], line), 3)}</span>;
    if (col.kind === 'amount') return <span style={{ width: w, display: 'inline-block', textAlign: 'right' }}><Text strong>{money(lineAmount(methodMap[g.method], line), symbol)}</Text></span>;
    return <Button size="small" danger type="text" icon={<DeleteOutlined />} onClick={() => updateGroup(gi, { lines: g.lines.filter((_, j) => j !== li) })} />;
  };

  const orderedIdx = groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => HEAD_ORDER.indexOf(a.g.head) - HEAD_ORDER.indexOf(b.g.head));

  return (
    <Row gutter={16}>
      <Col xs={24} lg={16}>
        <Card size="small" style={{ marginBottom: 16 }}>
          <Space wrap>
            <span>
              <Text type="secondary">Currency </Text>
              <Select
                style={{ width: 150 }}
                value={cs.currencyId ?? undefined}
                options={(currencies ?? []).map((c) => ({ label: `${c.code} (${c.symbol})`, value: c.id }))}
                onChange={(v) => setSheet({ currencyId: v })}
              />
            </span>
            <span>
              <Text type="secondary">Factory Expense % </Text>
              <InputNumber value={cs.factoryExpensePct} onChange={(v) => setSheet({ factoryExpensePct: v ?? 0 })} style={{ width: 90 }} />
            </span>
            <span>
              <Text type="secondary">Margin % </Text>
              <InputNumber value={cs.marginPct} onChange={(v) => setSheet({ marginPct: v ?? 0 })} style={{ width: 90 }} />
            </span>
          </Space>
        </Card>

        {groups.length === 0 && <Empty description="No cost groups yet. Add one to start costing." style={{ margin: '24px 0' }} />}

        {orderedIdx.map(({ g, i }) => {
          const def = methodDef(g.method);
          const cols = columnsFor(g.method, g.head);
          return (
            <Card key={i} size="small" style={{ marginBottom: 12, borderLeft: `4px solid ${headColor(g.head)}` }}
              title={
                <Row gutter={8} align="middle" style={{ paddingTop: 6, paddingBottom: 6 }}>
                  <Col>
                    <Select size="small" style={{ width: 170 }} value={g.head} onChange={(v) => updateGroup(i, { head: v })}
                      options={HEAD_ORDER.map((h) => ({ label: headLabel(h), value: h }))} />
                  </Col>
                  <Col>
                    <Input size="small" style={{ width: 180 }} placeholder="Group / material name" value={g.name} onChange={(e) => updateGroup(i, { name: e.target.value })} />
                  </Col>
                  <Col>
                    <Select size="small" style={{ width: 190 }} value={g.method} onChange={(v) => updateGroup(i, { method: v })}
                      options={(meta?.methods ?? []).map((m) => ({ label: m.label, value: m.code }))} />
                  </Col>
                  {def && !def.usesWeight && def.dims.length > 0 && (
                    <Col>
                      <Button size="small" icon={<ThunderboltOutlined />} onClick={() => applyWastage(i)}>
                        Apply wastage → costing dims
                      </Button>
                    </Col>
                  )}
                </Row>
              }
              extra={
                <Space>
                  <Text strong>{money(groupTotal(g, methodMap), symbol)}</Text>
                  <Button size="small" danger type="text" icon={<DeleteOutlined />} onClick={() => setGroups(groups.filter((_, j) => j !== i))} />
                </Space>
              }
            >
              {def && <Text type="secondary" style={{ fontSize: 12 }}>{def.label} — {def.hint}</Text>}
              {g.head === 'LABOUR' && (
                <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                  {stageSteps.length
                    ? 'Mapping a line to a stage is optional and changes nothing here — it only pre-fills that stage’s in-house piece rate when an order is created. What the worker is actually paid is set on the order.'
                    : 'Pick a stage line on the Details step to map these lines to production stages.'}
                </Text>
              )}
              <Divider style={{ margin: '8px 0' }} />
              {/* Fixed column labels */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 4, overflowX: 'auto', paddingBottom: 2 }}>
                {cols.map((c) => (
                  <div key={c.key} style={{ width: c.width, fontSize: 12, color: '#8c8c8c', fontWeight: 600, textAlign: c.kind === 'measure' || c.kind === 'amount' ? 'right' : 'left', flex: 'none' }}>
                    {c.label}
                  </div>
                ))}
              </div>
              {g.lines.map((line, li) => (
                <div key={li} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center', overflowX: 'auto' }}>
                  {cols.map((c) => (
                    <div key={c.key} style={{ flex: 'none' }}>
                      {renderCell(c, g, i, li, line)}
                    </div>
                  ))}
                </div>
              ))}
              <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => updateGroup(i, { lines: [...g.lines, blankLine()] })} style={{ marginTop: 6 }}>
                Add line
              </Button>
            </Card>
          );
        })}

        <Button type="dashed" icon={<PlusOutlined />} onClick={addGroup} block style={{ marginTop: 8 }}>
          Add Cost Group
        </Button>
      </Col>

      <Col xs={24} lg={8}>
        <Card style={{ position: 'sticky', top: 12 }} title="Live Cost Summary">
          {HEAD_ORDER.filter((h) => (summary.headTotals[h] ?? 0) !== 0).map((h) => (
            <Row key={h} justify="space-between" style={{ marginBottom: 4 }}>
              <Text type="secondary">{headLabel(h)}</Text>
              <Text>{money(summary.headTotals[h], symbol)}</Text>
            </Row>
          ))}
          <Divider style={{ margin: '10px 0' }} />
          <Row justify="space-between"><Text strong>Ex-Factory</Text><Text strong>{money(summary.exFactory, symbol)}</Text></Row>
          <Row justify="space-between" style={{ marginTop: 4 }}><Text>Forwarding</Text><Text>{money(summary.forwarding, symbol)}</Text></Row>
          <Row justify="space-between" style={{ marginTop: 4 }}><Text>Factory Exp. ({num(cs.factoryExpensePct)}%)</Text><Text>{money(summary.factoryExpense, symbol)}</Text></Row>
          <Row justify="space-between" style={{ marginTop: 4 }}><Text>Margin ({num(cs.marginPct)}%)</Text><Text>{money(summary.margin, symbol)}</Text></Row>
          <Divider style={{ margin: '10px 0' }} />
          <Row justify="space-between" align="middle">
            <Title level={5} style={{ margin: 0 }}>FOB</Title>
            <Title level={4} style={{ margin: 0, color: '#4e342e' }}>{money(summary.fob, symbol)}</Title>
          </Row>
          <Row justify="space-between" style={{ marginTop: 6 }}><Text type="secondary">Non-FOB</Text><Text>{money(summary.nonFob, symbol)}</Text></Row>
        </Card>
      </Col>
    </Row>
  );
}
