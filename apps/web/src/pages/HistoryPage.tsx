import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { StatusBadge } from '@proofloop/ui';
import { api, type HistoryPayload } from '../api';
import { StatePanel } from '../components/StatePanel';

export function HistoryPage({ repoId }: { repoId: string; runs?: unknown }) {
  const [data, setData] = useState<HistoryPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!repoId) return;
    setLoading(true);
    api
      .history(repoId)
      .then((r) => setData(r.data))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [repoId]);

  if (!repoId) return <StatePanel state="empty" message="Select a repository." />;
  if (loading) return <StatePanel state="loading" />;
  if (error) return <StatePanel state="error" message={error} />;
  if (!data?.runs.length) return <StatePanel state="empty" message="No runs yet." />;

  const { summary, runs, events } = data;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">History</h1>
      <p className="text-sm text-[var(--pl-muted)]">
        Per-run outcomes and metric events. Human accepts are SHA-bound — a newer head will not
        inherit an old green light.
      </p>
      <div className="grid gap-3 sm:grid-cols-4">
        {[
          ['Runs', summary.runs],
          ['Avg duration', `${summary.avgDurationMs} ms`],
          ['Failed / blocked', summary.failedOrBlocked],
          ['Unknown high-risk', summary.unknownHighRisk],
        ].map(([label, value]) => (
          <div key={String(label)} className="pl-card">
            <div className="text-xs text-[var(--pl-muted)]">{label}</div>
            <div className="mt-1 text-2xl font-semibold">{value}</div>
          </div>
        ))}
      </div>
      <div className="pl-card overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-[var(--pl-muted)]">
            <tr>
              <th className="py-2">Run</th>
              <th>Head</th>
              <th>Phase</th>
              <th>Status</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-t border-[var(--pl-border)]">
                <td className="py-2">
                  <Link className="font-[var(--pl-mono)] text-xs underline" to={`/runs/${r.id}`}>
                    {r.id.slice(0, 18)}…
                  </Link>
                </td>
                <td className="font-[var(--pl-mono)] text-xs">{r.headSha.slice(0, 8)}</td>
                <td className="text-xs text-[var(--pl-muted)]">{r.phase ?? '—'}</td>
                <td>
                  <StatusBadge status={r.overallStatus ?? r.status} />
                </td>
                <td>{r.totalDurationMs ?? '—'} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pl-card">
        <h2 className="text-sm font-semibold">Recent events</h2>
        <ul className="mt-2 space-y-1 text-xs text-[var(--pl-muted)]">
          {events.slice(0, 20).map((e) => (
            <li key={e.id} className="font-[var(--pl-mono)]">
              {e.createdAt} · {e.eventType}
              {e.runId ? ` · ${e.runId.slice(0, 12)}` : ''}
              {e.metadata?.overallStatus ? ` · ${String(e.metadata.overallStatus)}` : ''}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
