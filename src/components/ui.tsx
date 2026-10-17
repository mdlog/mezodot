import type { ReactNode } from 'react';
import {
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  Coins,
  GitBranch,
  RefreshCw,
  Shield,
  ShieldAlert,
  TrendingUp,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { SPARKLINE, type Activity, type ActivityKind } from '../data/mock';
import { fmt, money, timeAgo } from '../lib/format';

export function Sparkline({ values = SPARKLINE, color = '#6157d6' }: { values?: readonly number[]; color?: string }) {
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${34 - (value / 100) * 29}`).join(' ');
  return (
    <svg className="sparkline" viewBox="0 0 100 38" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Brand() {
  return (
    <div className="brand-lockup">
      <div className="brand-mark">
        <span />
        <span />
        <span />
        <i />
      </div>
      <div>
        <strong>mezodot</strong>
        <small>PROTOCOL / 01</small>
      </div>
    </div>
  );
}

export function SimTag() {
  return (
    <span className="sim-tag">
      <i /> SIMULATED DATA
    </span>
  );
}

export function PageTitle({ eyebrow, title, subtitle, right }: { eyebrow: string; title: string; subtitle: string; right?: ReactNode }) {
  return (
    <div className="page-title">
      <div>
        <div className="eyebrow">
          <span>{eyebrow}</span>
          <b>·</b>
          <span>MEZO HUB</span>
        </div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {right && <div className="title-actions">{right}</div>}
    </div>
  );
}

export function PanelTitle({ label, meta, action }: { label: string; meta?: string; action?: ReactNode }) {
  return (
    <div className="panel-title">
      <div>
        <h3>{label}</h3>
        {meta && <span>{meta}</span>}
      </div>
      {action}
    </div>
  );
}

export function SummaryStrip({ snapshot, time, icon: Icon }: { snapshot: ReactNode; time: string; icon: LucideIcon }) {
  return (
    <div className="summary-strip">
      <SimTag />
      <span className="snapshot">{snapshot}</span>
      <span className="snapshot-time">
        <Icon size={13} /> {time}
      </span>
    </div>
  );
}

export function StatCard({
  label,
  value,
  change,
  icon: Icon,
  accent = false,
  foot,
}: {
  label: string;
  value: string;
  change?: string;
  icon: LucideIcon;
  accent?: boolean;
  foot: string;
}) {
  return (
    <article className={`stat-card ${accent ? 'stat-card--accent' : ''}`}>
      <div className="stat-top">
        <span>{label}</span>
        <span className="stat-icon">
          <Icon size={15} />
        </span>
      </div>
      <div className="stat-value-row">
        <strong>{value}</strong>
        {change && (
          <span className="positive">
            <TrendingUp size={12} /> {change}
          </span>
        )}
      </div>
      <div className="stat-foot">
        <span>{foot}</span>
        <Sparkline color={accent ? '#bcb6ff' : '#635bd1'} />
      </div>
    </article>
  );
}

export function DisclaimerBar({ title, children, action, onAction }: { title: string; children: ReactNode; action: string; onAction: () => void }) {
  return (
    <div className="disclaimer-bar">
      <Shield size={15} />
      <span>
        <b>{title}</b> {children}
      </span>
      <button onClick={onAction}>
        {action} <ArrowRight size={13} />
      </button>
    </div>
  );
}

export function AmountInput({
  id,
  value,
  onChange,
  unit,
  onMax,
  large = false,
  max,
  autoFocus = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  unit: string;
  onMax: () => void;
  large?: boolean;
  max?: number;
  autoFocus?: boolean;
}) {
  return (
    <div className={`amount-input ${large ? 'amount-input--large' : ''}`}>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min="0"
        max={max}
        step="any"
        value={value}
        data-autofocus={autoFocus || undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      <span>{unit}</span>
      <button type="button" onClick={onMax}>
        MAX
      </button>
    </div>
  );
}

const EVENT_ICONS: Record<ActivityKind, LucideIcon> = {
  Supply: ArrowDownToLine,
  Withdraw: ArrowUpRight,
  'Cross-chain': GitBranch,
  Borrow: ArrowDownLeft,
  Repay: Undo2,
  Loop: RefreshCw,
  Interest: Coins,
  Liquidation: ShieldAlert,
  Rebalance: RefreshCw,
};

export function EventIcon({ kind }: { kind: ActivityKind }) {
  const Icon = EVENT_ICONS[kind];
  return (
    <span className={`event-icon event-${kind.toLowerCase().replace('-', '')}`}>
      <Icon size={15} />
    </span>
  );
}

export function StatusBadge({ status }: { status: Activity['status'] }) {
  return (
    <span className={`status-badge status-${status.toLowerCase()}`}>
      <i />
      {status}
    </span>
  );
}

/** Decimal places that make sense for an amount of the given asset. */
export const assetDigits = (asset: string): number => (asset === 'wETH' ? 2 : asset === 'MEZO' ? 2 : 0);

export function ActivityRow({ item, onClick }: { item: Activity; onClick: () => void }) {
  return (
    <button className="activity-row" onClick={onClick}>
      <EventIcon kind={item.kind} />
      <span className="activity-row-main">
        <b>
          {item.kind} {fmt(item.amount, assetDigits(item.asset))} {item.asset}
        </b>
        <small>
          {item.source} <ArrowRight size={11} /> {item.destination}
        </small>
      </span>
      <span className="activity-row-amount">{money(item.value, 2)}</span>
      <StatusBadge status={item.status} />
      <span className="activity-row-time">{timeAgo(item.at)}</span>
      <ChevronRight size={14} />
    </button>
  );
}
