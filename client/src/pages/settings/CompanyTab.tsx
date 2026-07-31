import { useEffect } from 'react';
import { Alert, App, Button, Card, Col, Divider, Form, Input, Popconfirm, Row, Space, Typography, Upload } from 'antd';
import { DeleteOutlined, UploadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiError } from '../../api/client';
import type { Company } from '../../api/types';

const { Text } = Typography;

/**
 * Who WE are. One record, and one field on it decides money: comparing `state` with the
 * buyer's is what makes a domestic sale CGST + SGST rather than IGST, so the tax split
 * is derived from the two addresses instead of being typed onto each document.
 */
export default function CompanyTab() {
  const [form] = Form.useForm();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { data, isLoading } = useQuery<Company>({ queryKey: ['company'], queryFn: async () => (await api.get('/company')).data });

  useEffect(() => {
    if (data) form.setFieldsValue(data);
  }, [data, form]);

  // The logo is a file, so it is uploaded on its own rather than with the form: a
  // half-saved form should never leave the letterhead in a different state.
  const uploadLogo = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.append('file', file);
      return (await api.post('/company/logo', body, { headers: { 'Content-Type': 'multipart/form-data' } })).data as Company;
    },
    onSuccess: () => {
      message.success('Logo updated.');
      qc.invalidateQueries({ queryKey: ['company'] });
    },
    onError: (e) => message.error(apiError(e)),
  });

  const removeLogo = useMutation({
    mutationFn: async () => (await api.delete('/company/logo')).data as Company,
    onSuccess: () => {
      message.success('Logo removed.');
      qc.invalidateQueries({ queryKey: ['company'] });
    },
    onError: (e) => message.error(apiError(e)),
  });

  const save = useMutation({
    mutationFn: async (values: Company) => (await api.put('/company', values)).data as Company,
    onSuccess: (saved) => {
      // The server warns rather than refuses when clearing the state would restate the
      // tax split on existing domestic documents.
      if (saved.warning) message.warning(saved.warning, 8);
      else message.success('Company details saved.');
      qc.invalidateQueries({ queryKey: ['company'] });
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['proformas'] });
    },
    onError: (e) => message.error(apiError(e)),
  });

  return (
    <Card
      loading={isLoading}
      title="Company"
      extra={
        <Button type="primary" loading={save.isPending} onClick={() => form.submit()}>
          Save
        </Button>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Your state decides the tax split"
        description="A domestic buyer in the same state is charged CGST + SGST; one in another state is charged IGST. That is worked out from these two addresses, never typed on a document. Leave the state empty and every domestic sale falls back to IGST."
      />
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="legalName" label="Legal name" rules={[{ required: true, message: 'What is the registered name?' }]}>
              <Input placeholder="Oswal Handicrafts" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="tradeName" label="Trading as / tagline">
              <Input placeholder="Furniture & Hardware Exporter" />
            </Form.Item>
          </Col>
        </Row>

        <Divider orientation="left" plain>
          Address — printed on every document
        </Divider>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="addressL1" label="Address line 1">
              <Input placeholder="Plot 44, Boranada Industrial Area" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="addressL2" label="Address line 2">
              <Input />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={12}>
          <Col span={6}>
            <Form.Item name="city" label="City">
              <Input placeholder="Jodhpur" />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item
              name="state"
              label="State"
              tooltip="Compared with the buyer's state to decide CGST + SGST versus IGST."
              extra={<Text type="secondary" style={{ fontSize: 12 }}>Must match how you spell it on buyers.</Text>}
            >
              <Input placeholder="Rajasthan" />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="pincode" label="PIN code">
              <Input placeholder="342012" />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="country" label="Country" rules={[{ required: true }]}>
              <Input placeholder="India" />
            </Form.Item>
          </Col>
        </Row>

        <Divider orientation="left" plain>
          Registrations
        </Divider>
        <Row gutter={12}>
          <Col span={6}>
            <Form.Item name="gstNo" label="GSTIN" tooltip="Printed on domestic tax documents.">
              <Input placeholder="08ABCDE1234F1Z5" />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="panNo" label="PAN">
              <Input placeholder="ABCDE1234F" />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="iecNo" label="IEC" tooltip="Importer-exporter code, printed on export documents.">
              <Input placeholder="0812345678" />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="cinNo" label="CIN">
              <Input />
            </Form.Item>
          </Col>
        </Row>

        <Divider orientation="left" plain>
          Contact
        </Divider>
        <Row gutter={12}>
          <Col span={8}>
            <Form.Item name="phone" label="Phone">
              <Input placeholder="+91 291 2740 155" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="email" label="E-mail" rules={[{ type: 'email', message: 'That does not look like an e-mail address.' }]}>
              <Input placeholder="exports@oswalhandicrafts.in" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="website" label="Website">
              <Input />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item name="bankDetails" label="Bank details" tooltip="Used on a proforma when the document does not carry its own.">
          <Input.TextArea rows={4} placeholder={'Bank: State Bank of India, Sardarpura, Jodhpur\nA/C: 3812 4457 9910\nIFSC: SBIN0031234'} />
        </Form.Item>

        <Divider orientation="left" plain>
          Branding
        </Divider>
        <Space align="start" size={16} style={{ marginBottom: 16 }}>
          <div
            style={{
              width: 96,
              height: 96,
              border: '1px dashed #d9d9d9',
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: '#fafafa',
              overflow: 'hidden',
            }}
          >
            {data?.logoFilename ? (
              <img src={`/uploads/${data.logoFilename}`} alt="Company logo" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
            ) : (
              <Text type="secondary" style={{ fontSize: 12, textAlign: 'center', padding: 6 }}>
                no logo
              </Text>
            )}
          </div>
          <Space direction="vertical" size={6}>
            <Upload
              accept=".jpg,.jpeg,.png,.gif,.webp"
              showUploadList={false}
              // Handled by the mutation above, not by antd's own uploader, so the bearer
              // token and error handling go through the shared axios instance.
              beforeUpload={(file) => {
                uploadLogo.mutate(file as unknown as File);
                return false;
              }}
            >
              <Button icon={<UploadOutlined />} loading={uploadLogo.isPending}>
                {data?.logoFilename ? 'Replace logo' : 'Upload logo'}
              </Button>
            </Upload>
            {data?.logoFilename && (
              <Popconfirm title="Remove the logo?" onConfirm={() => removeLogo.mutate()} okButtonProps={{ danger: true }}>
                <Button size="small" danger type="text" icon={<DeleteOutlined />} loading={removeLogo.isPending}>
                  Remove
                </Button>
              </Popconfirm>
            )}
            <Text type="secondary" style={{ fontSize: 12, maxWidth: 380, display: 'block' }}>
              Printed to the left of the company name on documents. JPEG or PNG appear on the PDF; GIF and WebP are accepted for the screen but the PDF falls back to text, because
              pdfkit can only embed JPEG and PNG. A square-ish image around 300&nbsp;px works best.
            </Text>
          </Space>
        </Space>

        <Space>
          <Button type="primary" loading={save.isPending} onClick={() => form.submit()}>
            Save
          </Button>
        </Space>
      </Form>
    </Card>
  );
}
