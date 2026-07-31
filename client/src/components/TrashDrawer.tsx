import { useState } from 'react';
import { App, Badge, Button, Drawer, Empty, Popconfirm, Space, Table, Tooltip, Typography } from 'antd';
import { DeleteOutlined, UndoOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api, apiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';

const { Text } = Typography;

export interface TrashRow {
  id: number;
  deletedAt: string;
  [k: string]: unknown;
}

/**
 * What is in the trash, and the two things you can do with it.
 *
 * Nothing here expires: items wait until somebody decides. Restoring and destroying for good
 * are separate permissions per record type, because destroying is the one action in the app
 * that genuinely loses data.
 */

/**
 * Which permission lets somebody destroy a record of this kind for good.
 *
 * Keyed on the collection endpoint the drawer was handed, so one generic component serves
 * seven record types without being told twice. An endpoint missing from this map shows NO
 * permanent-delete button at all — a new trashable model must be added here deliberately
 * rather than inheriting somebody else's purge permission by accident.
 */
const PURGE_PERMISSION: Record<string, string> = {
  '/products': 'products.purge',
  '/orders': 'orders.purge',
  '/proformas': 'proformas.purge',
  '/operation-sheets': 'sheets.purge',
  '/payments': 'payments.purge',
  '/shipments': 'shipments.purge',
  '/invoices': 'invoices.purge',
};
export default function TrashDrawer({
  open,
  onClose,
  title,
  endpoint,
  queryKeys,
  columns,
  label,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Collection root, e.g. `/products` or `/orders`. */
  endpoint: string;
  /** Everything to refresh once something comes back or goes for good. */
  queryKeys: readonly unknown[][];
  /** How to describe each row, beside the deleted-on date. */
  columns: { title: string; render: (r: TrashRow) => React.ReactNode; width?: number }[];
  /** What one row is called, for the messages. */
  label: string;
}) {
  const qc = useQueryClient();
  const { message } = App.useApp();
  // Permanent delete is per record type, so the drawer asks about the endpoint it was
  // given rather than about a rank. An endpoint with no purge permission listed shows no
  // permanent-delete affordance at all, which is the safe direction to fail in.
  const { can } = useAuth();
  const purgeKey = PURGE_PERMISSION[endpoint];
  const isAdmin = purgeKey ? can(purgeKey) : false;

  const { data, isLoading } = useQuery<TrashRow[]>({
    queryKey: ['trash', endpoint],
    queryFn: async () => (await api.get(`${endpoint}/trash`)).data,
    enabled: open,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['trash', endpoint] });
    for (const k of queryKeys) qc.invalidateQueries({ queryKey: k });
  };

  // Which row is busy, so one click does not put every button in a loading state.
  const [busy, setBusy] = useState<number | null>(null);

  const restore = useMutation({
    mutationFn: async (id: number) => {
      setBusy(id);
      return (await api.post(`${endpoint}/${id}/restore`)).data;
    },
    onSuccess: () => {
      message.success(`${label} restored.`);
      refresh();
    },
    onError: (e) => message.error(apiError(e)),
    onSettled: () => setBusy(null),
  });

  const purge = useMutation({
    mutationFn: async (id: number) => {
      setBusy(id);
      return (await api.delete(`${endpoint}/${id}/permanent`)).data;
    },
    onSuccess: () => {
      message.success(`${label} destroyed.`);
      refresh();
    },
    onError: (e) => message.error(apiError(e)),
    onSettled: () => setBusy(null),
  });

  return (
    <Drawer open={open} onClose={onClose} width={720} title={title}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          Deleted items are kept indefinitely — nothing is removed because time has passed. Restoring puts a record back exactly as it was.
          {!isAdmin && ' Destroying one for good needs an Admin.'}
        </Text>

        {(data ?? []).length === 0 && !isLoading ? (
          <Empty description="Nothing in the trash." />
        ) : (
          <Table<TrashRow>
            rowKey="id"
            size="small"
            loading={isLoading}
            dataSource={data ?? []}
            pagination={false}
            columns={[
              ...columns.map((c, i) => ({ key: `c${i}`, title: c.title, width: c.width, render: (_: unknown, r: TrashRow) => c.render(r) })),
              {
                key: 'when',
                title: 'Deleted',
                width: 150,
                render: (_: unknown, r: TrashRow) => (
                  <Tooltip title={dayjs(r.deletedAt).format('DD MMM YYYY, HH:mm')}>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {dayjs(r.deletedAt).format('DD MMM YYYY')}
                    </Text>
                  </Tooltip>
                ),
              },
              {
                key: 'act',
                title: '',
                width: 190,
                render: (_: unknown, r: TrashRow) => (
                  <Space size={4}>
                    <Button size="small" icon={<UndoOutlined />} loading={busy === r.id && restore.isPending} disabled={busy != null && busy !== r.id} onClick={() => restore.mutate(r.id)}>
                      Restore
                    </Button>
                    {isAdmin ? (
                      <Popconfirm
                        title="Destroy this for good?"
                        description="This cannot be undone. Restoring will no longer be possible."
                        okText="Destroy"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => purge.mutate(r.id)}
                      >
                        <Button size="small" danger type="text" icon={<DeleteOutlined />} loading={busy === r.id && purge.isPending} disabled={busy != null && busy !== r.id} />
                      </Popconfirm>
                    ) : (
                      <Tooltip title="Only an Admin can destroy a record for good.">
                        <Button size="small" danger type="text" icon={<DeleteOutlined />} disabled />
                      </Tooltip>
                    )}
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Space>
    </Drawer>
  );
}

/** The button that opens the drawer, showing how much is waiting. */
export function TrashButton({ endpoint, onClick }: { endpoint: string; onClick: () => void }) {
  const { data } = useQuery<TrashRow[]>({
    queryKey: ['trash', endpoint],
    queryFn: async () => (await api.get(`${endpoint}/trash`)).data,
    // Cheap and read-only, so it can keep the badge honest without being asked.
    staleTime: 30 * 1000,
  });
  const n = data?.length ?? 0;
  return (
    <Badge count={n} size="small" offset={[-2, 2]}>
      <Button size="small" icon={<DeleteOutlined />} onClick={onClick}>
        Trash
      </Button>
    </Badge>
  );
}
