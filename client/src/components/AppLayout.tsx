import { useEffect, useRef, useState } from 'react';
import { App, Layout, Menu, Avatar, Dropdown, Typography, Tag, Modal, Form, Input } from 'antd';
import {
  BoxPlotOutlined,
  ContainerOutlined,
  FileProtectOutlined,
  HomeOutlined,
  AppstoreOutlined,
  TeamOutlined,
  InboxOutlined,
  ToolOutlined,
  ShoppingOutlined,
  SettingOutlined,
  UsergroupAddOutlined,
  LogoutOutlined,
  KeyOutlined,
  UserOutlined,
  ProfileOutlined,
  TableOutlined,
  DashboardOutlined,
  FileDoneOutlined,
  FileTextOutlined,
  ShopOutlined,
  WalletOutlined,
  CalendarOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { apiError } from '../api/client';

const { Header, Sider, Content } = Layout;

/**
 * Which URL segments are menu keys, per module.
 *
 * Only these light a sidebar entry up; a detail page like `/sales/shipments/3` highlights
 * its section because the section is a PREFIX of it. Add a segment here whenever you add a
 * sub-section, or the sidebar goes blank on that page and nobody will report it as a bug.
 */
const SECTION_KEYS: Record<string, string[]> = {
  operations: ['orders', 'proformas', 'suppliers', 'stock', 'sheets', 'delivery'],
  sales: ['stock', 'packing', 'shipments'],
  finance: ['payments', 'invoices'],
  manforce: ['workers', 'muster', 'wages', 'statutory'],
};

/**
 * Which sidebar GROUP a page belongs to — its first URL segment, which is also the group's
 * key. `/operations/orders` is deliberately absent: Orders is a top-level entry now, so
 * opening an order does not expand a group it is not in.
 */
const GROUPS = new Set(['operations', 'sales', 'finance', 'manforce', 'products', 'settings']);
function groupFor(pathname: string): string | null {
  if (pathname.startsWith('/operations/orders')) return null;
  const seg = pathname.split('/')[1] ?? '';
  return GROUPS.has(seg) ? seg : null;
}

export default function AppLayout() {
  const { user, logout, hasRole, changePassword } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [pwOpen, setPwOpen] = useState(false);
  const [pwForm] = Form.useForm();
  const [pwSaving, setPwSaving] = useState(false);
  /** True while the menu is collapsed to zero width (below the `lg` breakpoint). */
  const [menuHidden, setMenuHidden] = useState(false);
  /**
   * Which groups are expanded. Controlled rather than `defaultOpenKeys`, which is read once
   * at mount — the layout never remounts between routes, so a group navigated into from
   * somewhere else would have stayed shut. Every group used to be open at once, which ran the
   * menu past the fold.
   */
  const [openKeys, setOpenKeys] = useState<string[]>(() => {
    const g = groupFor(location.pathname);
    return g ? [g] : [];
  });
  const contentRef = useRef<HTMLDivElement>(null);

  // The page area is its own scroll container now, so opening a new page has to put it
  // back to the top: the window's scroll position no longer resets for us, and an order
  // opened from halfway down a list would otherwise appear already scrolled.
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [location.pathname]);

  // Open the group you have navigated into, and leave alone any the user opened by hand —
  // collapsing those would fight whoever is browsing two modules at once.
  useEffect(() => {
    const g = groupFor(location.pathname);
    if (g) setOpenKeys((keys) => (keys.includes(g) ? keys : [...keys, g]));
  }, [location.pathname]);

  const submitPassword = async (v: { currentPassword: string; newPassword: string }) => {
    setPwSaving(true);
    try {
      await changePassword(v.currentPassword, v.newPassword);
      message.success('Password changed.');
      setPwOpen(false);
      pwForm.resetFields();
    } catch (e) {
      message.error(apiError(e));
    } finally {
      setPwSaving(false);
    }
  };

  /**
   * The menu, arranged around the ORDER.
   *
   * Orders sits at the top level rather than inside Operations, because the order page is now
   * the hub: from one order you reach its proforma, its products, its material sheets, its
   * cartons, the containers they went in and the invoices that billed them. The groups below
   * it are the LISTS — where you go to see every proforma or every shipment at once, not the
   * only way to reach one.
   *
   * Money has one home. Payments used to sit under Operations and invoices under Sales, which
   * put the two halves of one buyer's position on opposite sides of the menu.
   */
  const items = [
    { key: '/', icon: <HomeOutlined />, label: <Link to="/">Home</Link> },
    { key: '/operations/orders', icon: <FileDoneOutlined />, label: <Link to="/operations/orders">Orders</Link> },
    {
      key: 'operations',
      icon: <ToolOutlined />,
      label: 'Operations',
      children: [
        { key: '/operations', icon: <DashboardOutlined />, label: <Link to="/operations">Dashboard</Link> },
        { key: '/operations/proformas', icon: <FileTextOutlined />, label: <Link to="/operations/proformas">Proformas</Link> },
        { key: '/operations/delivery', icon: <CalendarOutlined />, label: <Link to="/operations/delivery">Delivery</Link> },
        { key: '/operations/sheets', icon: <ProfileOutlined />, label: <Link to="/operations/sheets">Material Sheets</Link> },
        { key: '/operations/suppliers', icon: <ShopOutlined />, label: <Link to="/operations/suppliers">Suppliers</Link> },
        { key: '/operations/stock', icon: <InboxOutlined />, label: <Link to="/operations/stock">Raw Stock</Link> },
      ],
    },
    {
      key: 'sales',
      icon: <ShoppingOutlined />,
      label: 'Dispatch',
      children: [
        { key: '/sales', icon: <DashboardOutlined />, label: <Link to="/sales">Dashboard</Link> },
        { key: '/sales/stock', icon: <InboxOutlined />, label: <Link to="/sales/stock">Finished Stock</Link> },
        { key: '/sales/packing', icon: <BoxPlotOutlined />, label: <Link to="/sales/packing">Packing</Link> },
        // Dispatch is Manager+; an Operator records packing and nothing else.
        ...(hasRole('Manager') ? [{ key: '/sales/shipments', icon: <ContainerOutlined />, label: <Link to="/sales/shipments">Shipments</Link> }] : []),
      ],
    },
    {
      key: 'finance',
      icon: <WalletOutlined />,
      label: 'Finance',
      children: [
        { key: '/finance', icon: <DashboardOutlined />, label: <Link to="/finance">Overview</Link> },
        { key: '/finance/payments', icon: <WalletOutlined />, label: <Link to="/finance/payments">Receipts & Payments</Link> },
        ...(hasRole('Manager') ? [{ key: '/finance/invoices', icon: <FileProtectOutlined />, label: <Link to="/finance/invoices">Invoices</Link> }] : []),
      ],
    },
    {
      key: 'manforce',
      icon: <TeamOutlined />,
      label: 'Manforce',
      children: [
        { key: '/manforce', icon: <DashboardOutlined />, label: <Link to="/manforce">Dashboard</Link> },
        { key: '/manforce/workers', icon: <TeamOutlined />, label: <Link to="/manforce/workers">Workers</Link> },
        { key: '/manforce/muster', icon: <CalendarOutlined />, label: <Link to="/manforce/muster">Muster Roll</Link> },
        { key: '/manforce/wages', icon: <WalletOutlined />, label: <Link to="/manforce/wages">Wages</Link> },
        ...(hasRole('Manager') ? [{ key: '/manforce/statutory', icon: <SafetyCertificateOutlined />, label: <Link to="/manforce/statutory">Statutory</Link> }] : []),
      ],
    },
    {
      key: 'products',
      icon: <AppstoreOutlined />,
      label: 'Products',
      children: [
        { key: '/products/catalogue', icon: <ProfileOutlined />, label: <Link to="/products/catalogue">Catalogue</Link> },
        { key: '/products/list', icon: <TableOutlined />, label: <Link to="/products/list">Product Details</Link> },
      ],
    },
    // Two entries that were top-level beside six modules; one group, opened only when needed.
    ...(hasRole('Manager')
      ? [
          {
            key: 'settings',
            icon: <SettingOutlined />,
            label: 'Settings',
            children: [
              { key: '/settings/masters', icon: <SettingOutlined />, label: <Link to="/settings/masters">Master Data</Link> },
              ...(hasRole('Admin') ? [{ key: '/settings/users', icon: <UsergroupAddOutlined />, label: <Link to="/settings/users">Users</Link> }] : []),
            ],
          },
        ]
      : []),
  ];

  const selected = (() => {
    const p = location.pathname;
    if (p.startsWith('/products/catalogue')) return ['/products/catalogue'];
    if (p.startsWith('/products')) return ['/products/list'];
    if (p.startsWith('/settings/masters')) return ['/settings/masters'];
    // Child routes (`/:id`, `/:id/edit`, `/new`) are not menu keys of their own, so each
    // module lists the segments that ARE. A sub-section missing from here silently
    // highlights nothing — add the segment in the same commit you add the route.
    // The module key stays part of the prefix, so `/operations/stock` and `/sales/stock`
    // cannot collide.
    for (const [mod, segs] of Object.entries(SECTION_KEYS)) {
      for (const seg of segs) if (p.startsWith(`/${mod}/${seg}`)) return [`/${mod}/${seg}`];
      if (p === `/${mod}`) return [`/${mod}`];
    }
    return [p];
  })();


  return (
    // The shell is exactly the viewport and never scrolls itself. That is what lets the
    // menu and the page scroll independently: with `minHeight` the document grew instead,
    // the window took the scroll, and `Content`'s `overflow: auto` never engaged — so a
    // long page dragged the whole menu off the top of the screen.
    <Layout style={{ height: '100vh', overflow: 'hidden' }}>
      <Header style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingInline: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 22 }}>🪵</div>
          <span className="brand-title" style={{ fontSize: 18 }}>
            Saraswati Export <span style={{ opacity: 0.7, fontWeight: 400 }}>· ERP</span>
          </span>
        </div>
        <Dropdown
          menu={{
            items: [
              { key: 'role', disabled: true, label: <Tag color="#6d4c41">{user?.role}</Tag> },
              { type: 'divider' },
              { key: 'password', icon: <KeyOutlined />, label: 'Change password', onClick: () => setPwOpen(true) },
              { key: 'logout', icon: <LogoutOutlined />, label: 'Sign out', onClick: () => { logout(); navigate('/login'); } },
            ],
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: '#fff' }}>
            <Avatar style={{ background: '#a1887f' }} icon={<UserOutlined />} />
            <span>{user?.name}</span>
          </div>
        </Dropdown>
      </Header>
      {/* `minHeight: 0` is load-bearing: without it a flex child refuses to shrink below
          its content, the row grows past the viewport, and both panes scroll together
          again however much overflow the children declare. */}
      <Layout style={{ flex: '1 1 auto', minHeight: 0 }}>
        <Sider
          width={230}
          breakpoint="lg"
          collapsedWidth={0}
          theme="dark"
          onBreakpoint={setMenuHidden}
          onCollapse={setMenuHidden}
          className="app-sider"
          style={{ overflowY: 'auto', overflowX: 'hidden' }}
        >
          <Menu theme="dark" mode="inline" selectedKeys={selected} openKeys={openKeys} onOpenChange={(k) => setOpenKeys(k as string[])} items={items} style={{ paddingTop: 8 }} />
        </Sider>
        {/* Below `lg` the menu collapses to nothing and Ant floats its open-menu button
            over the page; the extra left padding is the room that button needs, so it
            stops sitting on top of the first line of text. */}
        <Content ref={contentRef} style={{ padding: 24, paddingLeft: menuHidden ? 56 : 24, overflow: 'auto', minHeight: 0 }}>
          <Outlet />
        </Content>
      </Layout>

      <Modal title="Change password" open={pwOpen} onCancel={() => setPwOpen(false)} onOk={() => pwForm.submit()} confirmLoading={pwSaving} okText="Change" destroyOnHidden>
        <Form form={pwForm} layout="vertical" onFinish={submitPassword} style={{ marginTop: 12 }}>
          <Form.Item name="currentPassword" label="Current password" rules={[{ required: true, message: 'Enter your current password.' }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item name="newPassword" label="New password" rules={[{ required: true, min: 8, message: 'Use at least 8 characters.' }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="confirm"
            label="Confirm new password"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: 'Type it again.' },
              ({ getFieldValue }) => ({
                validator: (_, v) => (!v || v === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('The two passwords do not match.'))),
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </Layout>
  );
}
