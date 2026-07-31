import { useState } from 'react';
import { Breadcrumb, Card, Select, Space, Tabs, Typography, Result } from 'antd';
import { HomeOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import CompanyTab from './CompanyTab';
import MasterCrud, { type FieldDef } from '../../components/MasterCrud';
import FormulasTab from './FormulasTab';
import StageLinesTab from './StageLinesTab';
import WorkforceTab from './WorkforceTab';
import StatutoryTab from './StatutoryTab';
import SuggestionsTab from './SuggestionsTab';
import SalesTab from './SalesTab';
import CurrencyRatesImport from './CurrencyRatesImport';
import { useCurrencies, useMeta } from '../../api/hooks';
import { useAuth } from '../../auth/AuthContext';

const { Title, Text } = Typography;

const currencyFields: FieldDef[] = [
  { name: 'code', label: 'Code', type: 'text', required: true, width: 90 },
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'symbol', label: 'Symbol', type: 'text', width: 90 },
  { name: 'rateToBase', label: 'Rate to Base (INR)', type: 'number', step: 0.01, defaultValue: 1, required: true },
  { name: 'isBase', label: 'Base', type: 'switch', width: 90 },
  { name: 'isActive', label: 'Active', type: 'switch', defaultValue: true, width: 90 },
];

const unitFields: FieldDef[] = [
  { name: 'code', label: 'Code', type: 'text', required: true, width: 100 },
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'sortOrder', label: 'Order', type: 'number', defaultValue: 0, width: 90 },
  { name: 'isActive', label: 'Active', type: 'switch', defaultValue: true, width: 90 },
];

/**
 * Channel and market are INDEPENDENT, so all four combinations exist: an overseas
 * importer, a domestic dealer, a domestic walk-in, a web order from abroad. Market
 * decides the price basis (FOB vs Non-FOB), the document series and whether GST applies;
 * state decides CGST + SGST versus IGST against our own.
 */
const buyerFields: FieldDef[] = [
  { name: 'code', label: 'Code', type: 'text', required: true, width: 90 },
  { name: 'name', label: 'Name', type: 'text', required: true },
  {
    name: 'market',
    label: 'Market',
    type: 'select',
    defaultValue: 'OVERSEAS',
    width: 120,
    options: [
      { label: 'Overseas', value: 'OVERSEAS' },
      { label: 'Domestic', value: 'DOMESTIC' },
    ],
  },
  {
    name: 'channel',
    label: 'Channel',
    type: 'select',
    defaultValue: 'B2B',
    width: 100,
    options: [
      { label: 'B2B — trade', value: 'B2B' },
      { label: 'B2C — end customer', value: 'B2C' },
    ],
  },
  { name: 'state', label: 'State', type: 'text', width: 120 },
  { name: 'gstNo', label: 'GSTIN', type: 'text' },
  { name: 'country', label: 'Country', type: 'text' },
  { name: 'contactName', label: 'Contact', type: 'text', hideInTable: true },
  { name: 'email', label: 'Email', type: 'text', hideInTable: true },
  { name: 'phone', label: 'Phone', type: 'text', hideInTable: true },
  { name: 'address', label: 'Address', type: 'text', hideInTable: true },
  { name: 'isActive', label: 'Active', type: 'switch', defaultValue: true, width: 90 },
];

const tradeFields: FieldDef[] = [
  { name: 'name', label: 'Trade', type: 'text', required: true },
  { name: 'sortOrder', label: 'Order', type: 'number', defaultValue: 0, width: 90 },
  { name: 'isActive', label: 'Active', type: 'switch', defaultValue: true, width: 90 },
];

/** A labour contractor: their gang's earnings roll up here and one payment settles it. */
const contractorFields: FieldDef[] = [
  { name: 'code', label: 'Code', type: 'text', width: 100 },
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'contactName', label: 'Contact', type: 'text' },
  { name: 'phone', label: 'Phone', type: 'text', width: 130 },
  { name: 'gstNo', label: 'GST', type: 'text', hideInTable: true },
  { name: 'panNo', label: 'PAN', type: 'text', hideInTable: true },
  { name: 'address', label: 'Address', type: 'text', hideInTable: true },
  { name: 'paymentTerms', label: 'Terms', type: 'text', hideInTable: true },
  { name: 'isActive', label: 'Active', type: 'switch', defaultValue: true, width: 90 },
];

const attrFields: FieldDef[] = [
  { name: 'value', label: 'Value', type: 'text', required: true },
  { name: 'code', label: 'Code', type: 'text', width: 120 },
  { name: 'sortOrder', label: 'Order', type: 'number', defaultValue: 0, width: 90 },
  { name: 'isActive', label: 'Active', type: 'switch', defaultValue: true, width: 90 },
];

function CurrenciesTab() {
  const { data: currencies } = useCurrencies();
  return (
    <div>
      <CurrencyRatesImport currencies={currencies ?? []} />
      <MasterCrud endpoint="/currencies" queryKey={['currencies']} fields={currencyFields} />
    </div>
  );
}

function AttributesTab() {
  const { data: meta } = useMeta();
  const types = meta?.attributeTypes ?? [];
  const [type, setType] = useState<string>('PRODUCT_TYPE');
  return (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <Text>Attribute:</Text>
        <Select style={{ width: 220 }} value={type} onChange={setType} options={types.map((t) => ({ label: t.label, value: t.type }))} />
      </Space>
      <MasterCrud
        endpoint="/attributes"
        queryKey={['attributes', type]}
        fields={attrFields}
        fixed={{ type }}
        listParams={{ type }}
      />
    </div>
  );
}

export default function MastersPage() {
  const { hasRole } = useAuth();
  if (!hasRole('Manager')) {
    return <Result status="403" title="Restricted" subTitle="Master data is editable by Managers and Admins only." />;
  }

  return (
    <div>
      <Breadcrumb style={{ marginBottom: 16 }} items={[{ title: <Link to="/"><HomeOutlined /></Link> }, { title: 'Master Data' }]} />
      <Title level={3}>Master Data</Title>
      <Text type="secondary">These lists power the dropdowns, filters, costing and production routing across the whole ERP.</Text>
      <Card style={{ marginTop: 16 }}>
        {/* A left rail rather than a top row. Twelve sections do not fit across the top:
            at 1366px two of them ("Statutory", "Memory") already fell into an overflow
            "···" menu, so the last two things anybody configures were the two you could
            not see. Down the side they are all visible at any window width. */}
        <Tabs
          tabPosition="left"
          className="masters-tabs"
          items={[
            { key: 'company', label: 'Company', children: <CompanyTab /> },
            { key: 'currencies', label: 'Currencies', children: <CurrenciesTab /> },
            { key: 'units', label: 'Units', children: <MasterCrud endpoint="/units" queryKey={['units']} fields={unitFields} /> },
            { key: 'buyers', label: 'Buyers', children: <MasterCrud endpoint="/buyers" queryKey={['buyers']} fields={buyerFields} /> },
            { key: 'attributes', label: 'Attributes', children: <AttributesTab /> },
            { key: 'stage-lines', label: 'Stage Lines', children: <StageLinesTab /> },
            { key: 'formulas', label: 'Cost Formulas', children: <FormulasTab /> },
            { key: 'trades', label: 'Trades', children: <MasterCrud endpoint="/trades" queryKey={['trades']} fields={tradeFields} /> },
            { key: 'contractors', label: 'Contractors', children: <MasterCrud endpoint="/contractors" queryKey={['contractors']} fields={contractorFields} /> },
            { key: 'working-days', label: 'Working Days', children: <WorkforceTab /> },
            { key: 'statutory', label: 'Statutory', children: <StatutoryTab /> },
            { key: 'suggestions', label: 'Memory', children: <SuggestionsTab /> },
            { key: 'sales', label: 'Sales', children: <SalesTab /> },
          ]}
        />
      </Card>
    </div>
  );
}
