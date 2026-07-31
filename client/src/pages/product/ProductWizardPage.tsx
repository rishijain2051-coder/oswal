import { useEffect, useState } from 'react';
import { Alert, Breadcrumb, Button, Card, Skeleton, Space, Steps, Typography, App } from 'antd';
import { HomeOutlined, SaveOutlined, LeftOutlined, RightOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, apiError } from '../../api/client';
import { useCurrencies, useProduct } from '../../api/hooks';
import { emptyDraft, fromProduct, type WizardDraft } from './wizard/draft';
import StepDetails from './wizard/StepDetails';
import StepCosting from './wizard/StepCosting';
import StepRelated from './wizard/StepRelated';
import ProductImages from '../../components/ProductImages';
import type { ProductDetail } from '../../api/types';

const { Title, Text } = Typography;

export default function ProductWizardPage() {
  const { id } = useParams();
  const editing = !!id;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { message } = App.useApp();

  const { data: currencies } = useCurrencies();
  const { data: product, isLoading } = useProduct(editing ? id : undefined);

  const [draft, setDraft] = useState<WizardDraft | null>(null);
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<{ factoryCode?: boolean; name?: boolean }>({});

  // Initialise draft (new vs edit).
  useEffect(() => {
    if (editing) {
      if (product) setDraft(fromProduct(product));
    } else if (currencies && !draft) {
      const base = currencies.find((c) => c.isBase) ?? currencies[0];
      setDraft(emptyDraft(base?.id));
    }
  }, [editing, product, currencies]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<WizardDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const save = useMutation({
    mutationFn: async (payload: WizardDraft) => {
      if (editing) return (await api.put<ProductDetail>(`/products/${id}`, payload)).data;
      return (await api.post<ProductDetail>('/products', payload)).data;
    },
    onSuccess: (data) => {
      message.success(editing ? 'Product updated.' : 'Product created.');
      qc.invalidateQueries({ queryKey: ['products'] });
      qc.invalidateQueries({ queryKey: ['catalogue'] });
      qc.invalidateQueries({ queryKey: ['product', String(data.id)] });
      navigate(`/products/${data.id}`);
    },
    onError: (e) => message.error(apiError(e)),
  });

  const handleSave = () => {
    if (!draft) return;
    // Required top-level fields, highlighted inline on step 1.
    const fe = { factoryCode: !draft.factoryCode.trim(), name: !draft.name.trim() };
    setErrors(fe);
    if (fe.factoryCode || fe.name) {
      setStep(0);
      message.error(`Please fill: ${[fe.factoryCode && 'Factory Code', fe.name && 'Name'].filter(Boolean).join(' and ')}.`);
      return;
    }

    // Clean & validate the cost sheet: drop blank lines, flag half-filled ones.
    const problems: string[] = [];
    const groups = [];
    for (let gi = 0; gi < draft.costSheet.groups.length; gi++) {
      const g = draft.costSheet.groups[gi];
      const gLabel = g.name?.trim() ? `“${g.name.trim()}”` : `group ${gi + 1}`;
      const lines = [];
      for (let li = 0; li < g.lines.length; li++) {
        const l = g.lines[li];
        const blank =
          !l.name?.trim() && !l.rate && l.actualL == null && l.actualW == null && l.actualH == null &&
          l.costL == null && l.costW == null && l.costH == null && l.actualWeight == null && (l.qty == null || l.qty === 1);
        if (blank) continue;
        if (!l.name?.trim()) {
          problems.push(`Costing → ${gLabel} → line ${li + 1} needs an item name.`);
          continue;
        }
        lines.push(l);
      }
      if (lines.length === 0) continue;
      if (!g.name?.trim()) {
        problems.push(`Costing → group ${gi + 1} needs a name.`);
        continue;
      }
      groups.push({ ...g, lines });
    }
    if (problems.length) {
      setStep(1);
      message.error(problems.slice(0, 3).join(' '));
      return;
    }

    const payload: WizardDraft = {
      ...draft,
      buyers: draft.buyers.filter((b) => b.buyerId != null),
      related: draft.related.filter((r) => r.relatedId != null),
      costSheet: { ...draft.costSheet, groups },
    };
    save.mutate(payload);
  };

  if ((editing && isLoading) || !draft) return <Skeleton active paragraph={{ rows: 8 }} />;

  const steps = [
    { title: 'Product Detail', content: <StepDetails draft={draft} set={set} errors={errors} /> },
    { title: 'Costing Sheet', content: <StepCosting draft={draft} set={set} productId={editing ? Number(id) : undefined} /> },
    { title: 'Related Products', content: <StepRelated draft={draft} set={set} currentId={editing ? Number(id) : undefined} /> },
    {
      title: 'Images',
      content: editing ? (
        <Card title="Product Images">
          <ProductImages productId={Number(id)} images={product?.images ?? []} editable />
        </Card>
      ) : (
        <Alert
          type="info"
          showIcon
          message="Save the product to add images"
          description="Images attach to a saved product. Click “Create Product” below — you'll land on the product page where you can upload photos and set a primary image."
        />
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
          { title: <Link to="/products/list">Product Details</Link> },
          { title: editing ? `Edit ${draft.factoryCode}` : 'New Product' },
        ]}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>
          {editing ? 'Edit Product' : 'Create Product'}
        </Title>
        <Button type="primary" icon={<SaveOutlined />} loading={save.isPending} onClick={handleSave}>
          {editing ? 'Save Changes' : 'Create Product'}
        </Button>
      </div>

      <Steps current={step} onChange={setStep} items={steps.map((s) => ({ title: s.title }))} style={{ marginBottom: 20 }} />

      <div style={{ minHeight: 300 }}>{steps[step].content}</div>

      <Card size="small" style={{ marginTop: 16 }}>
        <Space style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Button icon={<LeftOutlined />} disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
            Back
          </Button>
          <Text type="secondary">Step {step + 1} of {steps.length}</Text>
          {step < steps.length - 1 ? (
            <Button type="primary" onClick={() => setStep((s) => s + 1)}>
              Next <RightOutlined />
            </Button>
          ) : (
            <Button type="primary" icon={<SaveOutlined />} loading={save.isPending} onClick={handleSave}>
              {editing ? 'Save Changes' : 'Create Product'}
            </Button>
          )}
        </Space>
      </Card>
    </div>
  );
}
