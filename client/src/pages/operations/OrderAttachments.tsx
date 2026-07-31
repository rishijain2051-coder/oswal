import { useState } from 'react';
import { App, Button, Card, Empty, Popconfirm, Select, Space, Table, Tag, Tooltip, Typography, Upload } from 'antd';
import { DeleteOutlined, DownloadOutlined, FileExcelOutlined, FileImageOutlined, FileOutlined, FilePdfOutlined, FileTextOutlined, FileWordOutlined, FileZipOutlined, UploadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api, apiError } from '../../api/client';
import { ATTACHMENT_LABEL_TEXT, ATTACHMENT_LABELS, fetchDocument, type OrderAttachment } from '../../api/ops';
import { useAuth } from '../../auth/AuthContext';

const { Text } = Typography;

/** An icon that matches what the file actually is. */
function fileIcon(name: string) {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  if (ext === 'pdf') return <FilePdfOutlined style={{ color: '#c62828' }} />;
  if (['xlsx', 'xls', 'csv'].includes(ext)) return <FileExcelOutlined style={{ color: '#2e7d32' }} />;
  if (['docx', 'doc'].includes(ext)) return <FileWordOutlined style={{ color: '#1565c0' }} />;
  if (['jpg', 'jpeg', 'png'].includes(ext)) return <FileImageOutlined style={{ color: '#6a1b9a' }} />;
  if (ext === 'zip') return <FileZipOutlined style={{ color: '#ef6c00' }} />;
  if (['txt', 'eml'].includes(ext)) return <FileTextOutlined style={{ color: '#546e7a' }} />;
  return <FileOutlined />;
}

const kb = (b?: number | null) => (b == null ? '—' : b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / (1024 * 1024)).toFixed(1)} MB`);

/**
 * Paperwork hanging off an order: the buyer's PO, a bill of lading, customs forms, a
 * packing list, an inspection certificate.
 *
 * Downloads go through axios rather than a plain link, because `/uploads` is behind auth
 * and a bare `<a href>` would send no bearer token.
 */
export default function OrderAttachments({ orderId, orderNumber }: { orderId: number; orderNumber: string }) {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { hasRole } = useAuth();
  const [label, setLabel] = useState<string>('PO_COPY');

  const { data, isLoading } = useQuery<OrderAttachment[]>({
    queryKey: ['order-attachments', orderId],
    queryFn: async () => (await api.get(`/orders/${orderId}/attachments`)).data,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['order-attachments', orderId] });
    qc.invalidateQueries({ queryKey: ['order', String(orderId)] });
  };

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const body = new FormData();
      for (const f of files) body.append('files', f);
      body.append('label', label);
      return (await api.post(`/orders/${orderId}/attachments`, body, { headers: { 'Content-Type': 'multipart/form-data' } })).data;
    },
    onSuccess: (res: { added?: number; skipped?: number }) => {
      // The server reports what it dropped rather than silently returning survivors.
      if (res?.skipped) message.warning(`${res.added ?? 0} attached, ${res.skipped} rejected — the contents did not match the file type.`);
      else message.success(res?.added && res.added > 1 ? `${res.added} files attached.` : 'Attached.');
      refresh();
    },
    onError: (e) => message.error(apiError(e)),
  });

  const relabel = useMutation({
    mutationFn: async ({ id, next }: { id: number; next: string }) => (await api.patch(`/orders/${orderId}/attachments/${id}`, { label: next })).data,
    onSuccess: refresh,
    onError: (e) => message.error(apiError(e)),
  });

  const remove = useMutation({
    mutationFn: async (id: number) => api.delete(`/orders/${orderId}/attachments/${id}`),
    onSuccess: () => {
      message.success('Removed.');
      refresh();
    },
    onError: (e) => message.error(apiError(e)),
  });

  const rows = data ?? [];
  const totalBytes = rows.reduce((a, r) => a + (r.sizeBytes ?? 0), 0);

  return (
    <Card
      size="small"
      title={`Attachments${rows.length ? ` (${rows.length})` : ''}`}
      extra={
        rows.length > 0 ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {kb(totalBytes)} total
          </Text>
        ) : null
      }
    >
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        {hasRole('Operator') && (
          <Space wrap>
            <Select
              size="small"
              style={{ width: 190 }}
              value={label}
              onChange={setLabel}
              options={ATTACHMENT_LABELS.map((l) => ({ value: l, label: ATTACHMENT_LABEL_TEXT[l] }))}
            />
            <Upload
              multiple
              accept=".pdf,.xlsx,.xls,.docx,.doc,.jpg,.jpeg,.png,.txt,.csv,.zip,.dwg,.eml"
              showUploadList={false}
              // Sent through the shared axios instance so the bearer token and the
              // standard error handling apply.
              // rc-upload calls beforeUpload ONCE PER FILE and hands over the whole
              // list each time, so posting `fileList` here uploaded 3 files 3 times —
              // nine rows and nine files on disk. Send the batch only on the last call.
              beforeUpload={(file, fileList) => {
                if (file === fileList[fileList.length - 1]) upload.mutate(fileList as unknown as File[]);
                return false;
              }}
            >
              <Button size="small" icon={<UploadOutlined />} loading={upload.isPending}>
                Attach files
              </Button>
            </Upload>
            <Text type="secondary" style={{ fontSize: 12 }}>
              PDF, Word, Excel, images, CSV, text, ZIP, DWG, EML · up to 25 MB each
            </Text>
          </Space>
        )}

        {rows.length === 0 && !isLoading ? (
          <Empty image={null} description={<Text type="secondary">No paperwork attached yet.</Text>} />
        ) : (
          <Table<OrderAttachment>
            rowKey="id"
            size="small"
            loading={isLoading}
            dataSource={rows}
            pagination={false}
            columns={[
              {
                title: 'File',
                dataIndex: 'originalName',
                render: (v: string | null, r) => (
                  <Space size={6}>
                    {fileIcon(r.filename)}
                    <Button
                      type="link"
                      size="small"
                      style={{ padding: 0 }}
                      onClick={() => fetchDocument(`/orders/${orderId}/attachments/${r.id}`, v ?? r.filename).catch((e) => message.error(apiError(e)))}
                    >
                      {v ?? r.filename}
                    </Button>
                  </Space>
                ),
              },
              {
                title: 'Kind',
                dataIndex: 'label',
                width: 190,
                render: (v: string | null, r) =>
                  hasRole('Operator') ? (
                    <Select
                      size="small"
                      variant="borderless"
                      style={{ width: 180 }}
                      value={v ?? 'OTHER'}
                      onChange={(next) => relabel.mutate({ id: r.id, next })}
                      options={ATTACHMENT_LABELS.map((l) => ({ value: l, label: ATTACHMENT_LABEL_TEXT[l] }))}
                    />
                  ) : (
                    <Tag>{ATTACHMENT_LABEL_TEXT[(v ?? 'OTHER') as keyof typeof ATTACHMENT_LABEL_TEXT]}</Tag>
                  ),
              },
              { title: 'Size', dataIndex: 'sizeBytes', width: 90, align: 'right', render: (v: number | null) => <Text type="secondary" style={{ fontSize: 12 }}>{kb(v)}</Text> },
              {
                title: 'Added',
                dataIndex: 'createdAt',
                width: 120,
                render: (v: string) => (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {dayjs(v).format('DD MMM YYYY')}
                  </Text>
                ),
              },
              {
                key: 'act',
                width: 78,
                render: (_, r) => (
                  <Space size={0}>
                    <Tooltip title="Download">
                      <Button
                        size="small"
                        type="text"
                        icon={<DownloadOutlined />}
                        onClick={() => fetchDocument(`/orders/${orderId}/attachments/${r.id}`, r.originalName ?? r.filename).catch((e) => message.error(apiError(e)))}
                      />
                    </Tooltip>
                    {hasRole('Manager') && (
                      <Popconfirm title="Remove this file?" description="The file itself is deleted." okButtonProps={{ danger: true }} onConfirm={() => remove.mutate(r.id)}>
                        <Button size="small" danger type="text" icon={<DeleteOutlined />} />
                      </Popconfirm>
                    )}
                  </Space>
                ),
              },
            ]}
          />
        )}
        <Text type="secondary" style={{ fontSize: 12 }}>
          Attached to {orderNumber}. Files are stored with the app and served only to signed-in users.
        </Text>
      </Space>
    </Card>
  );
}
