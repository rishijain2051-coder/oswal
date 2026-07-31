import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import AppRoutes from './App';
import { AuthProvider } from './auth/AuthContext';
import 'antd/dist/reset.css';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: '#6d4c41',
          colorLink: '#6d4c41',
          borderRadius: 8,
          fontSize: 14,
        },
        components: {
          Layout: { headerBg: '#4e342e', siderBg: '#3e2723' },
          Menu: { darkItemBg: '#3e2723', darkItemSelectedBg: '#6d4c41' },
        },
      }}
    >
      <AntApp>
        <QueryClientProvider client={queryClient}>
          {/* Opting into the two v7 behaviours now, which is what the router was warning
              about on every boot: state updates wrapped in `React.startTransition`, and
              relative paths inside a splat route resolving the v7 way. Taking them here
              means the upgrade is already done rather than waiting to be a surprise. */}
          <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <AuthProvider>
              <AppRoutes />
            </AuthProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>
);
