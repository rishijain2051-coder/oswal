import { Alert, Space, Table, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { useChangeLog, type ChangeLogRow, type ChangeRoot } from '../api/suggest';
import { NoHistory } from './HistoryHint';

const { Text } = Typography;

const ENTITY_LABEL: Record<string, string> = {
  CostLine: 'Costing line',
  CostSheet: 'Costing sheet',
  OrderLine: 'Order line',
  ProformaLine: 'Proforma line',
  OrderLineStage: 'Production stage',
  Worker: 'Worker',
  StatutoryComponent: 'Statutory levy',
};

/**
 * Who changed which figure, from what to what.
 *
 * Only money and rates are logged — see `server/src/lib/changeLog.ts`. This answers the
 * one question the live records cannot, because an edit overwrites the old value.
 */
export default function ChangeLogList({ rootType, rootId, what = 'record', compact }: { rootType: ChangeRoot; rootId?: number | string; what?: string; compact?: boolean }) {
  const { data, isLoading } = useChangeLog(rootType, rootId);

  if (!isLoading && (data ?? []).length === 0) return <NoHistory what={what} />;

  return (
    <>
      {!compact && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="Only figures are logged"
          description="Rates, prices and wages — the numbers where “what was it before?” matters. Ordinary edits are left out on purpose, so this list stays readable."
        />
      )}
      <Table<ChangeLogRow>
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={data ?? []}
        pagination={(data ?? []).length > 20 ? { pageSize: 20 } : false}
        columns={[
          { title: 'When', dataIndex: 'at', width: 150, render: (d) => dayjs(d).format('DD MMM YY, HH:mm') },
          { title: 'By', dataIndex: 'userName', width: 130, render: (v) => v || <Text type="secondary">—</Text> },
          {
            title: 'What',
            dataIndex: 'label',
            render: (v, r) => (
              <span>
                {v}
                <br />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {ENTITY_LABEL[r.entity] ?? r.entity}
                </Text>
              </span>
            ),
          },
          {
            title: 'Change',
            key: 'change',
            width: 240,
            render: (_, r) => (
              <Space size={6}>
                {r.oldValue == null ? (
                  <Tag color="green">added</Tag>
                ) : (
                  <Text delete type="secondary">
                    {r.oldValue}
                  </Text>
                )}
                {r.newValue == null ? <Tag color="red">removed</Tag> : <b>{r.newValue}</b>}
              </Space>
            ),
          },
        ]}
      />
    </>
  );
}
