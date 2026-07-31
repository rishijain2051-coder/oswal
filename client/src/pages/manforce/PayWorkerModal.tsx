import { useEffect } from 'react';
import { Alert, App, DatePicker, Form, Input, InputNumber, Modal, Typography } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api, apiError } from '../../api/client';
import { MANFORCE_KEYS, useWorkforceSettings, type WorkerDetail } from '../../api/manforce';
import { money, num } from '../../util/format';

const { Text } = Typography;

export type PayMode = 'PAY' | 'ADVANCE' | 'DEDUCT';

/**
 * Pay a worker, hand over an advance, or charge something back to them.
 *
 * There is no pay period and no suggested amount to accept — you type what actually
 * changed hands, on the day it did. The balance is worked out from that.
 */
export default function PayWorkerModal({ mode, worker, onClose }: { mode: PayMode | null; worker: WorkerDetail; onClose: () => void }) {
  const [form] = Form.useForm();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { data: settings } = useWorkforceSettings();
  const p = worker.position;

  useEffect(() => {
    if (!mode) return;
    form.setFieldsValue({
      date: dayjs(),
      amount: mode === 'PAY' ? Math.max(p.dueNow, 0) || undefined : undefined,
      recoveryPerMonth: settings?.defaultAdvanceRecovery || 0,
      reason: undefined,
      ref: '',
      note: '',
    });
  }, [mode, form, p.dueNow, settings?.defaultAdvanceRecovery]);

  const submit = useMutation({
    mutationFn: async (v: any) => {
      const date = (v.date ?? dayjs()).toISOString();
      if (mode === 'ADVANCE') {
        return api.post(`/workers/${worker.id}/advances`, { amount: v.amount, date, recoveryPerMonth: v.recoveryPerMonth ?? 0, ref: v.ref || null, note: v.note || null });
      }
      if (mode === 'DEDUCT') {
        return api.post(`/workers/${worker.id}/deductions`, { amount: v.amount, reason: v.reason, date, note: v.note || null });
      }
      // A wage payment is an ordinary ledger entry, so it sits with every other
      // money movement in the business rather than in a payroll silo.
      return api.post('/payments', {
        partyType: 'WORKER',
        workerId: worker.id,
        partyName: worker.name,
        kind: 'PAYMENT',
        amount: v.amount,
        date,
        ref: v.ref || null,
        note: v.note || 'Wages paid',
      });
    },
    onSuccess: () => {
      message.success(mode === 'ADVANCE' ? 'Advance recorded.' : mode === 'DEDUCT' ? 'Deduction charged.' : 'Payment recorded.');
      for (const key of MANFORCE_KEYS) qc.invalidateQueries({ queryKey: key });
      onClose();
    },
    onError: (e) => message.error(apiError(e)),
  });

  const title = mode === 'ADVANCE' ? `Advance to ${worker.name}` : mode === 'DEDUCT' ? `Charge ${worker.name}` : `Pay ${worker.name}`;

  return (
    <Modal open={mode != null} title={title} onCancel={onClose} okText="Record" confirmLoading={submit.isPending} onOk={() => form.submit()} destroyOnHidden>
      {mode === 'PAY' && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={`Due now ${money(p.dueNow, '₹', 0)}`}
          description={
            <span>
              Earned {money(p.earned, '₹', 0)} · paid {money(p.paid, '₹', 0)}
              {p.advanceOutstanding > 0 ? ` · advance outstanding ${money(p.advanceOutstanding, '₹', 0)}` : ''}. Pay any amount you like — nothing has to be settled in full.
            </span>
          }
        />
      )}
      {mode === 'ADVANCE' && p.advanceOutstanding > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`${worker.name} already has ${money(p.advanceOutstanding, '₹', 0)} outstanding`}
          description={`${money(p.advanceRecovered, '₹', 0)} has been worked off so far.`}
        />
      )}

      <Form form={form} layout="vertical" onFinish={(v) => submit.mutate(v)}>
        <Form.Item name="amount" label="Amount (₹)" rules={[{ required: true, message: 'How much?' }]}>
          <InputNumber min={0.01} style={{ width: '100%' }} autoFocus />
        </Form.Item>
        <Form.Item name="date" label="Date" rules={[{ required: true }]}>
          <DatePicker style={{ width: '100%' }} format="DD MMM YYYY" />
        </Form.Item>

        {mode === 'ADVANCE' && (
          <Form.Item
            name="recoveryPerMonth"
            label="Recover per month (₹)"
            extra="How much of the worker's monthly earnings goes towards this advance. Zero means it is absorbed as fast as they earn, which is the same as a payment that outran their wages."
          >
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        )}

        {mode === 'DEDUCT' && (
          <Form.Item name="reason" label="Reason" rules={[{ required: true, message: 'What is being charged?' }]}>
            <Input placeholder="Canteen, damage, tool loss, fine…" />
          </Form.Item>
        )}

        {mode !== 'DEDUCT' && (
          <Form.Item name="ref" label="Reference">
            <Input placeholder="Voucher or UPI reference" />
          </Form.Item>
        )}
        <Form.Item name="note" label="Note">
          <Input.TextArea rows={2} />
        </Form.Item>

        {mode === 'DEDUCT' && (
          <Text type="secondary">
            A deduction reduces what the factory owes — no cash moves. It shows on the statement and comes off the {num(p.dueNow, 0)} ₹ due now.
          </Text>
        )}
      </Form>
    </Modal>
  );
}
