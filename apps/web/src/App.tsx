import { useState } from 'react';
import {
  Activity as ActivityIcon,
  ArrowDownLeft,
  BarChart3,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  LayoutDashboard,
  Menu,
  Network,
  Radio,
  RefreshCw,
  RotateCcw,
  Route,
  TriangleAlert,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react';
import { ActionModal } from './components/ActionModal';
import { ActivityDetailModal } from './components/ActivityDetailModal';
import { Brand } from './components/ui';
import { PROTOCOL } from './data/mock';
import type { View } from './hooks/useHashRoute';
import { Activity } from './pages/Activity';
import { Agents } from './pages/Agents';
import { Architecture } from './pages/Architecture';
import { Borrow } from './pages/Borrow';
import { Crosschain } from './pages/Crosschain';
import { Dashboard } from './pages/Dashboard';
import { Loop } from './pages/Loop';
import { Markets } from './pages/Markets';
import { AppProvider, useApp } from './state/AppContext';

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
  const { view, go, showToast, reset } = useApp();
  return (
    <aside className={`sidebar ${open ? 'sidebar--open' : ''}`}>
      <div className="sidebar-brand">
        <Brand />
        <button className="mobile-close icon-button" onClick={onClose} aria-label="Close navigation">
          <X size={17} />
        </button>
      </div>
      <button className="workspace-switch" onClick={() => showToast('Mezodot Protocol demo workspace')}>
        <span className="workspace-emblem">
          <Network size={14} />
        </span>
        <span>
          <b>Mezodot</b>
          <small>Protocol workspace</small>
        </span>
        <ChevronDown size={14} />
      </button>
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
                {key === 'crosschain' && <i className="nav-link-indicator" />}
              </a>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <button className="help-link" onClick={reset}>
          <RotateCcw size={15} /> Reset demo state
        </button>
        <button className="help-link" onClick={() => showToast('Help center is not connected in this prototype')}>
          <CircleHelp size={15} /> Documentation <ExternalLink size={12} />
        </button>
        <div className="sidebar-network">
          <div>
            <span className="network-icon">M</span>
            <span>
              <b>{PROTOCOL.network}</b>
              <small>
                <i /> {PROTOCOL.environment}
              </small>
            </span>
          </div>
        </div>
        <div className="sidebar-footer">
          <span>MEZODOT UI</span>
          <span>
            v0.10.0 <i>·</i> DEMO
          </span>
        </div>
      </div>
    </aside>
  );
}

function Topbar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { view, connected, openModal, showToast } = useApp();
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
        <button className="network-selector network-selector--button" onClick={() => showToast(`Active network: ${PROTOCOL.network} · simulation only`)}>
          <span className="network-icon">M</span>
          <span>
            Mezo <small>·</small> Hub
          </span>
          <ChevronDown size={12} />
        </button>
        <button className="icon-button notification-button" onClick={() => showToast('No new demo notifications')} aria-label="Notifications">
          <Bell size={16} />
          <i />
        </button>
        <button
          className={`wallet-button ${connected ? 'wallet-button--connected' : ''}`}
          onClick={() => (connected ? showToast(`Demo account · ${PROTOCOL.demoAddress}`) : openModal({ type: 'wallet' }))}
        >
          {connected ? (
            <>
              <span className="wallet-status-dot" />
              {PROTOCOL.demoAddress}
            </>
          ) : (
            <>
              <Wallet size={15} /> Connect wallet
            </>
          )}
        </button>
      </div>
    </header>
  );
}

function ToastView() {
  const { toast, dismissToast } = useApp();
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
  const { view } = useApp();
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
              <span>Productive capital, across chains.</span>
              <div>
                <span>TERMS</span>
                <span>RISK DISCLOSURE</span>
                <span>© 2026 MEZODOT</span>
              </div>
            </footer>
          </div>
        </div>
      </main>
      <ActionModal />
      <ActivityDetailModal />
      <ToastView />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
