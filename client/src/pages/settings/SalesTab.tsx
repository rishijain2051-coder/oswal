import { useEffect } from 'react';
import { Alert, App, Button, Card, Col, Form, Radio, Row, Typography } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, apiError } from '../../api/client';
import { useAppSettings } from '../../api/suggest';
import { useAuth } from '../../auth/AuthContext';
import MasterCrud, { type FieldDef } from '../../components/MasterCrud';
import { SALES_KEYS } from '../../api/sales';
import { OPS_KEYS } from '../../api/ops';

const { Paragraph, Text } = Typography;

/**
 * Container types are DATA, like the cost formulas and the stage lines — a new box size is a
 * row, not a release. `isActive`, not a soft delete: master data already has a way to hide a
 * row, and two mechanisms would mean two ways to do one job.
 */
const containerTypeFields: FieldDef[] = [
  { name: 'code', label: 'Code', type: 'text', required: true, width: 100 },
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'capacityCbm', label: 'Capacity (CBM)', type: 'number', step: 0.1, required: true, width: 140 },
  { name: 'payloadKg', label: 'Max payload (kg)', type: 'number', step: 1, required: true, width: 150 },
  { name: 'sortOrder', label: 'Order', type: 'number', defaultValue: 0, width: 90 },
  { name: 'isActive', label: 'Active', type: 'switch', defaultValue: true, width: 90 },
];

export default function SalesTab() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { can } = useAuth();
  const canEdit = can('settings.app');
  const { data } = useAppSettings();
  const [form] = Form.useForm();

  useEffect(() => {
    if (data) form.setFieldsValue({ receivableBasis: data.receivableBasis ?? 'ORDER' });
  }, [data, form]);

  const save = useMutation({
    mutationFn: (v: { receivableBasis: string }) => api.put('/app-settings', v),
    onSuccess: () => {
      message.success('Saved. Every balance has been restated.');
      qc.invalidateQueries({ queryKey: ['app-settings'] });
      /**
       * EVERY cached money figure was computed under the old basis. Leaving one behind is
       * exactly how the dashboard and the Payments page end up showing different money, so
       * the whole finance and sales surface goes at once.
       */
      for (const k of [...SALES_KEYS, ...OPS_KEYS]) qc.invalidateQueries({ queryKey: k });
    },
    onError: (e) => message.error(apiError(e)),
  });

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={13}>
        <Card size="small" title="Container types">
          <Paragraph type="secondary" style={{ fontSize: 12 }}>
            The boxes you book, and what each can hold. The capacity is the usable internal volume and the payload is the most it may legally carry — tare weight counts against the
            payload, because the limit is on what crosses a weighbridge. A capacity of <b>0</b> means “not a container” (an LCL part load) and can never be over capacity.
          </Paragraph>
          <MasterCrud endpoint="/container-types" queryKey={['container-types']} fields={containerTypeFields} />
          <Text type="secondary" style={{ fontSize: 12 }}>
            A type already used on a shipment cannot be deleted — mark it inactive instead, so the shipments that used it keep their capacities.
          </Text>
        </Card>
      </Col>

      <Col xs={24} lg={11}>
        <Card size="small" title="When a buyer starts owing us money">
          <Paragraph type="secondary" style={{ fontSize: 12 }}>
            Allocation is worked out fresh on every read, so this setting <b>restates every balance and statement immediately</b> — there is nothing to migrate and nothing to
            rebuild. It changes what a receivable <i>is</i>, not what has been recorded.
          </Paragraph>
          {!canEdit && <Alert type="info" showIcon style={{ marginBottom: 16 }} message="Only an Admin can change this." />}
          <Form form={form} layout="vertical" disabled={!canEdit} onFinish={(v) => save.mutate(v)}>
            <Form.Item
              name="receivableBasis"
              label="A receivable arises"
              extra="On the invoice basis a confirmed order is not yet a receivable — it shows as order book until it is billed. Only an ISSUED invoice counts; a draft has not been sent to anybody."
            >
              <Radio.Group>
                <Radio.Button value="ORDER">When the order is confirmed</Radio.Button>
                <Radio.Button value="INVOICE">When an invoice is issued</Radio.Button>
              </Radio.Group>
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={save.isPending} disabled={!canEdit}>
              Save
            </Button>
          </Form>
        </Card>
      </Col>
    </Row>
  );
}
