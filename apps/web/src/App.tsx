import { useState } from 'react';
import {
  Activity as ActivityIcon,
  ArrowDownLeft,
  BarChart3,
  Check,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  LayoutDashboard,
  Menu,
  Network,
  Radio,
  RefreshCw,
  Route,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { ActionModal } from './components/ActionModal';
import { ChainLogo } from './components/Logos';
import { Brand } from './components/ui';
import { ENV_NAME, HUB, HUB_DEPLOYED, SPOKES } from './chain/env';
import type { View } from './hooks/useHashRoute';
import { Activity } from './pages/Activity';
import { Agents } from './pages/Agents';
import { Architecture } from './pages/Architecture';
import { Borrow } from './pages/Borrow';
import { Crosschain } from './pages/Crosschain';
import { Dashboard } from './pages/Dashboard';
import { Loop } from './pages/Loop';
import { Markets } from './pages/Markets';
import { UiProvider, useUi } from './state/UiContext';

type NavItem = { key: View; label: string; icon: LucideIcon; group: 'PROTOCOL' | 'CAPITAL' | 'INTELLIGENCE' };

const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', label: 'Overview', icon: LayoutDashboard, group: 'PROTOCOL' },
  { key: 'markets', label: 'Markets', icon: BarChart3, group: 'PROTOCOL' },
  { key: 'crosschain', label: 'Cross-chain', icon: Route, group: 'CAPITAL' },
  { key: 'borrow', label: 'Borrow', icon: ArrowDownLeft, group: 'CAPITAL' },
  { key: 'loop', label: 'Loop', icon: RefreshCw, group: 'CAPITAL' },
  { key: 'agents', label: 'Agents & risk', icon: Radio, group: 'INTELLIGENCE' },
  { key: 'architecture', label: 'Architecture', icon: Network, group: 'INTELLIGENCE' },
  { key: 'activity', label: 'Activity', icon: ActivityIcon, group: 'INTELLIGENCE' },
];
const NAV_GROUPS = ['PROTOCOL', 'CAPITAL', 'INTELLIGENCE'] as const;

const PAGES: Record<View, () => JSX.Element> = {
  dashboard: Dashboard,
  markets: Markets,
  crosschain: Crosschain,
  borrow: Borrow,
  loop: Loop,
  agents: Agents,
  architecture: Architecture,
  activity: Activity,
};

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { view, go } = useUi();
  return (
    <aside className={`sidebar ${open ? 'sidebar--open' : ''}`}>
      <div className="sidebar-brand">
        <Brand />
        <button className="mobile-close icon-button" onClick={onClose} aria-label="Close navigation">
          <X size={17} />
        </button>
      </div>
      <nav className="side-nav" aria-label="Main navigation">
        {NAV_GROUPS.map((group) => (
          <div className="nav-group" key={group}>
            <span className="nav-group-label">{group}</span>
            {NAV_ITEMS.filter((item) => item.group === group).map(({ key, label, icon: Icon }) => (
              <a
                key={key}
                href={key === 'dashboard' ? '#/' : `#/${key}`}
                className={`nav-link ${view === key ? 'nav-link--active' : ''}`}
                aria-current={view === key ? 'page' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  go(key);
                  onClose();
                }}
              >
                <Icon size={16} />
                <span>{label}</span>
              </a>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <a className="help-link" href="https://github.com/mezo-org" target="_blank" rel="noreferrer">
          <CircleHelp size={15} /> Mezo developer docs <ExternalLink size={12} />
        </a>
        <div className="sidebar-network">
          <div>
            <ChainLogo network={HUB.name} size={23} />
            <span>
              <b>{HUB.label}</b>
              <small>
                <i className={HUB_DEPLOYED ? '' : 'dot-off'} />{' '}
                {HUB_DEPLOYED ? `Hub live · ${SPOKES.length} spoke${SPOKES.length === 1 ? '' : 's'}` : 'Not deployed yet'}
              </small>
            </span>
          </div>
        </div>
        <div className="sidebar-footer">
          <span>MEZODOT</span>
          <span>
            v1.0 <i>·</i> {ENV_NAME.toUpperCase()}
          </span>
        </div>
      </div>
    </aside>
  );
}

function Topbar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { view } = useUi();
  const label = NAV_ITEMS.find((item) => item.key === view)?.label ?? 'Overview';
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="mobile-menu-button icon-button" onClick={onOpenMenu} aria-label="Open navigation">
          <Menu size={18} />
        </button>
        <div className="breadcrumb">
          <span>MEZODOT</span>
          <ChevronRight size={13} />
          <b>{label.toUpperCase()}</b>
        </div>
      </div>
      <div className="topbar-right">
        <ConnectButton chainStatus="icon" accountStatus="address" showBalance={false} />
      </div>
    </header>
  );
}

function ToastView() {
  const { toast, dismissToast } = useUi();
  if (!toast) return null;
  return (
    <div className={`toast toast--${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
      <span>{toast.tone === 'error' ? <TriangleAlert size={14} /> : <Check size={14} />}</span>
      {toast.message}
      <button onClick={dismissToast} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}

function Shell() {
  const { view } = useUi();
  const [mobileMenu, setMobileMenu] = useState(false);
  const Page = PAGES[view];

  return (
    <div className="app-shell">
      <Sidebar open={mobileMenu} onClose={() => setMobileMenu(false)} />
      {mobileMenu && <button className="mobile-scrim" onClick={() => setMobileMenu(false)} aria-label="Close navigation overlay" />}
      <main className="main-shell">
        <Topbar onOpenMenu={() => setMobileMenu(true)} />
        <div className="content-area">
          <div className="page-container">
            <Page />
            <footer className="page-footer">
              <Brand />
              <span>Productive capital, across chains. Built on Mezo.</span>
              <div>
                <span>UNAUDITED</span>
                <span>TESTNET ONLY</span>
                <span>© 2026 MEZODOT</span>
              </div>
            </footer>
          </div>
        </div>
      </main>
      <ActionModal />
      <ToastView />
    </div>
  );
}

export default function App() {
  return (
    <UiProvider>
      <Shell />
    </UiProvider>
  );
}
