import { useState } from 'react';
import { Button, Card, Form, Input, Typography, Alert } from 'antd';
import { LockOutlined, MailOutlined } from '@ant-design/icons';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { apiError } from '../api/client';

const { Title, Text, Paragraph } = Typography;

/** Empty in a production build, so nothing ships pre-filled. */
const DEV_LOGIN = import.meta.env.DEV ? { email: 'admin@oswal.local', password: 'admin123' } : undefined;

export default function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (user) return <Navigate to="/" replace />;

  const onFinish = async (values: { email: string; password: string }) => {
    setLoading(true);
    setError(null);
    try {
      await login(values.email, values.password);
      navigate('/');
    } catch (e) {
      setError(apiError(e, 'Login failed.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'linear-gradient(135deg, #4e342e 0%, #6d4c41 60%, #a1887f 100%)',
        padding: 16,
      }}
    >
      <Card style={{ width: 400, boxShadow: '0 16px 48px rgba(0,0,0,0.25)' }}>
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 40 }}>🪵</div>
          <Title level={3} style={{ marginBottom: 0 }}>
            Oswal Handicrafts
          </Title>
          <Text type="secondary">Enterprise Resource Planning</Text>
        </div>
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
        {/* The demo credentials are filled in and printed BELOW only in development.
            A production build that arrives at the factory with the administrator's
            password on the sign-in screen is not a convenience, it is the whole lock
            left hanging open. `import.meta.env.DEV` is compiled away in the build. */}
        <Form layout="vertical" onFinish={onFinish} initialValues={DEV_LOGIN}>
          <Form.Item name="email" label="Email" rules={[{ required: true, type: 'email' }]}>
            <Input prefix={<MailOutlined />} placeholder="you@oswal.local" size="large" autoComplete="username" autoFocus />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={[{ required: true }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="••••••••" size="large" autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block size="large" loading={loading}>
            Sign in
          </Button>
        </Form>
        {import.meta.env.DEV && (
          <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 16, marginBottom: 0, textAlign: 'center' }}>
            Demo: admin@oswal.local / admin123
          </Paragraph>
        )}
      </Card>
    </div>
  );
}
