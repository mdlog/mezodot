import { useMemo, useState } from 'react';
import { Activity as ActivityIcon, ArrowDownToLine, ArrowRight, ChevronRight, CircleHelp, Clock3, Filter } from 'lucide-react';
import { EventIcon, PageTitle, PanelTitle, StatusBadge, SummaryStrip, assetDigits } from '../components/ui';
import { ACTIVITY_KINDS, type ActivityKind } from '../data/mock';
import { fmt, money, timeAgo } from '../lib/format';
import { useApp } from '../state/AppContext';

type FilterValue = 'All activity' | ActivityKind;
const FILTERS: FilterValue[] = ['All activity', ...ACTIVITY_KINDS];

export function Activity() {
  const { state, setSelectedActivity, showToast } = useApp();
  const [filter, setFilter] = useState<FilterValue>('All activity');
  const activities = state.activities;
  const filtered = useMemo(() => activities.filter((item) => filter === 'All activity' || item.kind === filter), [activities, filter]);

  const exportCsv = () => {
    const header = ['id', 'kind', 'asset', 'amount', 'value_usd', 'source', 'destination', 'status', 'time', 'ref', 'detail'];
    const escape = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const rows = filtered.map((a) =>
      [a.id, a.kind, a.asset, a.amount, a.value.toFixed(2), a.source, a.destination, a.status, new Date(a.at).toISOString(), a.tx, a.detail]
        .map(escape)
        .join(','),
    );
    const blob = new Blob([[header.join(','), ...rows].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'mezodot-demo-activity.csv';
    link.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${filtered.length} simulated records`);
  };

  return (
    <>
      <PageTitle
        eyebrow="INTELLIGENCE / 07"
        title="Every move, accounted for."
        subtitle="A unified event trail across Mezo Hub actions, external Spokes, yield, loops, and keeper simulations."
        right={
          <button className="button button--outline" onClick={exportCsv} disabled={filtered.length === 0}>
            <ArrowDownToLine size={14} /> Export CSV
          </button>
        }
      />
      <SummaryStrip
        snapshot={
          <>
            ACTIVITY LEDGER <i>/</i> {activities.length} SAMPLE RECORDS
          </>
        }
        time="Local demo history"
        icon={Clock3}
      />

      <section className="panel activity-ledger">
        <div className="ledger-toolbar">
          <PanelTitle label="Protocol activity" meta="Newest first" />
          <div className="filter-controls">
            <span>
              <Filter size={13} />
            </span>
            <select aria-label="Filter activity" value={filter} onChange={(e) => setFilter(e.target.value as FilterValue)}>
              {FILTERS.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="table-wrap">
          <table className="ledger-table">
            <thead>
              <tr>
                <th>EVENT</th>
                <th>ASSET / AMOUNT</th>
                <th>ROUTE</th>
                <th>STATUS</th>
                <th>WHEN</th>
                <th>REF</th>
                <th>
                  <span className="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr key={item.id}>
                  <td>
                    <div className="event-cell">
                      <EventIcon kind={item.kind} />
                      <span>
                        <b>{item.kind}</b>
                        <small>{item.destination}</small>
                      </span>
                    </div>
                  </td>
                  <td>
                    <b>
                      {fmt(item.amount, assetDigits(item.asset))} {item.asset}
                    </b>
                    <small className="table-subline">{money(item.value, 2)}</small>
                  </td>
                  <td>
                    <div className="route-cell">
                      {item.source}
                      <ArrowRight size={12} />
                      {item.destination.split(' · ')[0]}
                    </div>
                  </td>
                  <td>
                    <StatusBadge status={item.status} />
                  </td>
                  <td>{timeAgo(item.at)}</td>
                  <td>
                    <code className="tx-code">{item.tx}</code>
                  </td>
                  <td>
                    <button className="icon-button" onClick={() => setSelectedActivity(item)} aria-label={`View ${item.kind} details`}>
                      <ChevronRight size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div className="empty-state">
            <ActivityIcon size={23} />
            <b>No events in this filter</b>
            <span>Try another event type.</span>
          </div>
        )}
        <div className="ledger-foot">
          <span>
            Showing {filtered.length} of {activities.length} demo records
          </span>
          <span>
            Transaction references are illustrative <CircleHelp size={13} />
          </span>
        </div>
      </section>
    </>
  );
}
