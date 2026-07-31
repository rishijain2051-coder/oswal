import { useState } from 'react';
import TrashDrawer, { TrashButton } from '../../components/TrashDrawer';
import { Breadcrumb, Button, Card, Input, Select, Space, Table, Tag, Popconfirm, Tooltip, Typography, App } from 'antd';
import { PlusOutlined, HomeOutlined, EditOutlined, DeleteOutlined, EyeOutlined, ClearOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ColumnsType } from 'antd/es/table';
import { useAttributes, useBuyers, useProducts, type ProductFilters } from '../../api/hooks';
import { api, apiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { money, statusColor } from '../../util/format';
import ProductThumb from '../../components/ProductThumb';
import type { ProductSummary } from '../../api/types';

const { Title, Text } = Typography;

export default function ProductListPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [trashOpen, setTrashOpen] = useState(false);
  const { message } = App.useApp();
  const qc = useQueryClient();

  const [filters, setFilters] = useState<ProductFilters>({});
  const { data: products, isLoading } = useProducts(filters);
  const { data: productTypes } = useAttributes('PRODUCT_TYPE');
  const { data: sizes } = useAttributes('SIZE');
  const { data: colours } = useAttributes('COLOUR');
  const { data: materials } = useAttributes('MATERIAL');
  const { data: buyers } = useBuyers();

  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/products/${id}`),
    onSuccess: () => {
      message.success('Product deleted.');
      qc.invalidateQueries({ queryKey: ['products'] });
    },
    onError: (e) => message.error(apiError(e)),
  });

  const opt = (arr?: { id: number; value: string }[]) => (arr ?? []).map((a) => ({ label: a.value, value: a.id }));

  const columns: ColumnsType<ProductSummary> = [
    { title: '', dataIndex: 'primaryImage', width: 56, render: (u) => <ProductThumb url={u} /> },
    {
      title: 'Factory Code',
      dataIndex: 'factoryCode',
      render: (code, r) => (
        <Link to={`/products/${r.id}`} style={{ fontWeight: 600 }}>
          {code}
        </Link>
      ),
      sorter: (a, b) => a.factoryCode.localeCompare(b.factoryCode),
    },
    {
      title: 'Product',
      dataIndex: 'name',
      render: (name, r) => (
        <div>
          <div>{name}</div>
          {r.alias && <Text type="secondary" style={{ fontSize: 12 }}>{r.alias}</Text>}
        </div>
      ),
    },
    { title: 'Type', dataIndex: 'productType', render: (v) => v || '—' },
    { title: 'Size', dataIndex: 'size', render: (v) => v || '—' },
    { title: 'Colour', dataIndex: 'colour', render: (v) => v || '—' },
    {
      title: 'Buyers',
      dataIndex: 'buyers',
      render: (bs: ProductSummary['buyers']) =>
        bs.length ? bs.map((b) => <Tag key={b.code}>{b.code}{b.buyerCode ? ` · ${b.buyerCode}` : ''}</Tag>) : '—',
    },
    {
      title: 'FOB',
      dataIndex: 'fob',
      align: 'right',
      render: (v, r) => (v != null ? money(v, r.currency?.symbol ?? '₹') : '—'),
      sorter: (a, b) => (a.fob ?? 0) - (b.fob ?? 0),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      render: (s) => <Tag color={statusColor(s)}>{s}</Tag>,
      filters: [
        { text: 'Active', value: 'Active' },
        { text: 'Draft', value: 'Draft' },
        { text: 'Discontinued', value: 'Discontinued' },
      ],
      onFilter: (val, r) => r.status === val,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 130,
      render: (_, r) => (
        <Space>
          <Tooltip title="Open this product">
            <Button size="small" aria-label="Open this product" icon={<EyeOutlined />} onClick={() => navigate(`/products/${r.id}`)} />
          </Tooltip>
          {can('products.edit') && (
            <Tooltip title="Edit this product">
              <Button size="small" aria-label="Edit this product" icon={<EditOutlined />} onClick={() => navigate(`/products/${r.id}/edit`)} />
            </Tooltip>
          )}
          {can('products.delete') && (
            <Popconfirm title="Delete this product?" onConfirm={() => del.mutate(r.id)} okText="Delete" okButtonProps={{ danger: true }}>
              <Tooltip title="Move to trash">
                <Button size="small" danger aria-label="Move this product to the trash" icon={<DeleteOutlined />} />
              </Tooltip>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Breadcrumb
        style={{ marginBottom: 16 }}
        items={[
          { title: <Link to="/"><HomeOutlined /></Link> },
          { title: <Link to="/products">Products</Link> },
          { title: 'Product Details' },
        ]}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>
          Product Details
        </Title>
        <Space>
          {can('products.restore') && <TrashButton endpoint="/products" onClick={() => setTrashOpen(true)} />}
          {can('products.create') && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/products/new')}>
              Create Product
            </Button>
          )}
        </Space>
      </div>

      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          {/* A filter box needs an id/name for the browser to identify it, and
              autoComplete="off" because a search term is not data worth remembering. */}
          <Input.Search
            id="product-list-search"
            name="product-list-search"
            autoComplete="off"
            allowClear
            placeholder="Search code / name / alias"
            style={{ width: 240 }}
            onSearch={(v) => setFilters((f) => ({ ...f, q: v || undefined }))}
            onChange={(e) => !e.target.value && setFilters((f) => ({ ...f, q: undefined }))}
          />
          <Select allowClear placeholder="Product Type" style={{ width: 160 }} options={opt(productTypes)} onChange={(v) => setFilters((f) => ({ ...f, productTypeId: v }))} />
          <Select allowClear placeholder="Size" style={{ width: 120 }} options={opt(sizes)} onChange={(v) => setFilters((f) => ({ ...f, sizeId: v }))} />
          <Select allowClear placeholder="Colour" style={{ width: 150 }} options={opt(colours)} onChange={(v) => setFilters((f) => ({ ...f, colourId: v }))} />
          <Select allowClear placeholder="Material" style={{ width: 150 }} options={opt(materials)} onChange={(v) => setFilters((f) => ({ ...f, materialId: v }))} />
          <Select allowClear placeholder="Buyer" style={{ width: 180 }} options={(buyers ?? []).map((b) => ({ label: `${b.code} · ${b.name}`, value: b.id }))} onChange={(v) => setFilters((f) => ({ ...f, buyerId: v }))} />
          <Button icon={<ClearOutlined />} onClick={() => setFilters({})}>
            Clear
          </Button>
        </Space>
      </Card>

      <Table<ProductSummary>
        rowKey="id"
        loading={isLoading}
        columns={columns}
        dataSource={products ?? []}
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `${t} products` }}
        scroll={{ x: 1000 }}
      />
      <TrashDrawer
        open={trashOpen}
        onClose={() => setTrashOpen(false)}
        title="Deleted products"
        endpoint="/products"
        label="Product"
        queryKeys={[['products'], ['catalogue']]}
        columns={[
          { title: 'Code', width: 130, render: (r) => <b>{String(r.factoryCode)}</b> },
          { title: 'Name', render: (r) => String(r.name) },
        ]}
      />
    </div>
  );
}
