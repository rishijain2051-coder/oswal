import { useEffect } from 'react';
import { Alert, App, Button, Card, Col, Form, InputNumber, Row, Typography } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, apiError } from '../../api/client';
import { useAppSettings } from '../../api/suggest';
import { useAuth } from '../../auth/AuthContext';

const { Paragraph, Text } = Typography;

/**
 * How far back "what did we use last time" looks, and when a figure counts as odd.
 *
 * Nothing here is stored alongside the suggestions — they are worked out from the live
 * records on every read, so changing the window simply changes what the next answer
 * takes into account.
 */
export default function SuggestionsTab() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { can } = useAuth();
  const canEdit = can('settings.app');
  const { data } = useAppSettings();
  const [form] = Form.useForm();

  useEffect(() => {
    if (data) form.setFieldsValue({ suggestionWindowDays: data.suggestionWindowDays, outlierPct: data.outlierPct });
  }, [data, form]);

  const save = useMutation({
    mutationFn: (v: { suggestionWindowDays: number; outlierPct: number }) => api.put('/app-settings', v),
    onSuccess: () => {
      message.success('Saved. The next suggestion uses the new window.');
      qc.invalidateQueries({ queryKey: ['app-settings'] });
      // Every cached suggestion was computed under the old rules.
      qc.invalidateQueries({ queryKey: ['suggest-cost-lines'] });
      qc.invalidateQueries({ queryKey: ['suggest-price'] });
      qc.invalidateQueries({ queryKey: ['suggest-rate'] });
    },
    onError: (e) => message.error(apiError(e)),
  });

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={12}>
        <Card size="small" title="What the app remembers">
          <Paragraph type="secondary" style={{ fontSize: 12 }}>
            Beside a rate, a price or a wage the app shows what it was last time — the same line in other products, what a supplier actually billed for that material, what vendors
            charged and workers earned for that stage, and what a buyer last paid. All of it is read from the live records when asked, so a correction to the original shows up
            immediately and there is no second copy to go stale.
          </Paragraph>
          {!canEdit && <Alert type="info" showIcon style={{ marginBottom: 16 }} message="Only an Admin can change these." />}
          <Form form={form} layout="vertical" disabled={!canEdit} onFinish={(v) => save.mutate(v)}>
            <Form.Item
              name="suggestionWindowDays"
              label="Look back this many days"
              extra="Older figures are not offered at all. A year keeps seasonal prices in view without dragging up rates nobody would honour today. Zero means no limit."
              rules={[{ required: true }]}
            >
              <InputNumber min={0} max={3650} style={{ width: '100%' }} addonAfter="days" />
            </Form.Item>
            <Form.Item
              name="outlierPct"
              label="Flag a figure this far from the average"
              extra="A quiet amber note beside the field, never a block — it exists to catch ₹2,600 typed for ₹260 at the moment it happens. It only appears once there are at least two past uses to compare with."
              rules={[{ required: true }]}
            >
              <InputNumber min={0} max={1000} style={{ width: '100%' }} addonAfter="%" />
            </Form.Item>
            {canEdit && (
              <Button type="primary" loading={save.isPending} onClick={() => form.submit()}>
                Save
              </Button>
            )}
          </Form>
        </Card>
      </Col>

      <Col xs={24} lg={12}>
        <Card size="small" title="Where it shows up">
          <ul style={{ paddingLeft: 18, marginBottom: 12 }}>
            <li>
              <Text strong>Costing wizard</Text> — a marker beside every rate. It knows what that line cost in other products, what the material actually cost from a supplier, and for a
              labour line mapped to a stage, what vendors and workers were really paid for it.
            </li>
            <li>
              <Text strong>Proformas and orders</Text> — what this buyer last paid for the product, then every buyer's range, in the same currency. Beside the existing FOB suggestion.
            </li>
            <li>
              <Text strong>Routing drawer</Text> — what this vendor, and any vendor, charged for that stage; and what the in-house piece rate has been.
            </li>
            <li>
              <Text strong>Stock inward</Text> — what this supplier and others billed for the item, and what it is costed at in product sheets.
            </li>
            <li>
              <Text strong>Worker rates</Text> — what others in the same trade are on.
            </li>
          </ul>
          <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
            Separately, every change to a rate, price or wage is recorded with who made it and what it was before — on the <Text strong>History</Text> tab of the product, order or
            worker it belongs to. That is the one thing suggestions cannot tell you, because an edit destroys the old value.
          </Paragraph>
        </Card>
      </Col>
    </Row>
  );
}
