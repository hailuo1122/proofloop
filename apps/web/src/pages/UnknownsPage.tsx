import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { StatusBadge } from '@proofloop/ui';
import { api, type EvidencePack } from '../api';
import { StatePanel } from '../components/StatePanel';
import { rejectedReviews } from '../lib/evidenceKind';

export function UnknownsPage() {
  const { runId } = useParams();
  const [pack, setPack] = useState<EvidencePack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [lastReject, setLastReject] = useState<{
    claimId: string;
    reason: string;
    overallStatus: string;
  } | null>(null);

  async function reload() {
    if (!runId || runId === '_') return;
    const e = await api.evidence(runId);
    setPack(e.data);
    window.dispatchEvent(new CustomEvent('proofloop:run-updated', { detail: { runId } }));
  }

  useEffect(() => {
    if (!runId || runId === '_') return;
    setLoading(true);
    reload()
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [runId]);

  async function confirm(claimId: string, decision: 'accept' | 'reject') {
    if (!runId) return;
    if (!note.trim()) {
      setError('Review note is required for the audit trail.');
      return;
    }
    setBusy(claimId);
    setError(null);
    try {
      const res = await api.confirmClaim(runId, claimId, {
        decision,
        note: note.trim(),
      });
      await reload();
      if (decision === 'reject') {
        setLastReject({
          claimId,
          reason: note || res.data.reason || 'Rejected without note',
          overallStatus: res.data.overallStatus,
        });
      } else {
        setLastReject(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!runId || runId === '_') return <StatePanel state="empty" message="Select a run." />;
  if (loading) return <StatePanel state="loading" />;
  if (!pack && error) return <StatePanel state="error" message={error} />;
  const unknowns = pack?.unknowns ?? [];
  const rejects = pack ? rejectedReviews(pack) : [];

  if (!pack) {
    return <StatePanel state="partial" message="Evidence pack unavailable." />;
  }

  if (!unknowns.length) {
    return (
      <div className="space-y-3">
        <StatePanel
          state="completed"
          message={
            pack?.mergeGate?.allowMerge
              ? 'No unknowns remain. Merge gate allows merge.'
              : 'No unknowns listed. Check Overview for remaining blockers.'
          }
        />
        {pack?.mergeGate ? (
          <p className="text-sm text-[var(--pl-muted)]">{pack.mergeGate.reason}</p>
        ) : null}
        {rejects.length ? (
          <section className="pl-card border-[color:var(--pl-blocked)]">
            <h2 className="text-sm font-semibold text-[var(--pl-blocked)]">Rejected</h2>
            {rejects.map((r) => (
              <div key={r.id} className="mt-2 text-sm">
                <StatusBadge status="blocked" />{' '}
                <span className="font-[var(--pl-mono)] text-xs">{r.claimId}</span>
                <p className="mt-1 text-[var(--pl-muted)]">
                  {r.reviewer}: {r.note || 'No reason'} · sha {r.headSha.slice(0, 12)}
                </p>
              </div>
            ))}
            <p className="mt-3 text-sm">
              Fix the code, then use <strong>Run check</strong> in the header to verify the new
              commit. Old accepts do not transfer.
            </p>
          </section>
        ) : null}
        {runId ? (
          <Link className="text-sm underline" to={`/runs/${runId}`}>
            View Overview merge status
          </Link>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h1 className="text-lg font-semibold">Unknowns</h1>
      {error ? <StatePanel state="error" message={error} /> : null}
      <p className="text-sm text-[var(--pl-muted)]">
        These assertions lack sufficient executed evidence. High-risk items need dynamic tests or
        explicit human confirmation — not AI reassurance. Accept is a{' '}
        <strong>manual verification</strong> bound to{' '}
        <code className="pl-mono text-xs">{pack?.run.headSha.slice(0, 12)}</code>.
      </p>
      {pack?.mergeGate && !pack.mergeGate.allowMerge ? (
        <StatePanel
          state="partial"
          message={`needs-human-review · ${pack.mergeGate.reason}`}
        />
      ) : null}
      {lastReject ? (
        <section className="pl-card border-[color:var(--pl-blocked)]">
          <h2 className="text-sm font-semibold text-[var(--pl-blocked)]">Reject recorded</h2>
          <p className="mt-1 text-sm">
            Claim <code className="pl-mono text-xs">{lastReject.claimId}</code> → blocked
          </p>
          <p className="mt-1 text-sm text-[var(--pl-muted)]">Reason: {lastReject.reason}</p>
          <p className="mt-1 text-xs text-[var(--pl-muted)]">
            Overall: {lastReject.overallStatus} · merge blocked
          </p>
          <p className="mt-3 text-sm">
            Next: fix the issue, then click <strong>Run check</strong> in the header on the new
            commit.
          </p>
        </section>
      ) : null}
      <label className="block text-sm">
        <span className="text-xs uppercase text-[var(--pl-muted)]">Review note (required for audit)</span>
        <input
          className="mt-1 w-full rounded border border-[var(--pl-border)] bg-white px-2 py-1.5"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Why you accept or reject this claim"
        />
      </label>
      {unknowns.map((u) => {
        const claimId = String(u.claimId ?? '');
        return (
          <article key={String(u.id)} className="pl-card">
            <h2 className="font-medium">{String(u.title)}</h2>
            <p className="mt-2 text-sm">{String(u.reason)}</p>
            <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase text-[var(--pl-muted)]">Suggested verification</dt>
                <dd>{String(u.suggestedVerification ?? '—')}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-[var(--pl-muted)]">Why it matters</dt>
                <dd>{String(u.importance ?? '—')}</dd>
              </div>
            </dl>
            {claimId ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  className="rounded bg-[#0f7b4c] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                  disabled={busy === claimId}
                  onClick={() => void confirm(claimId, 'accept')}
                >
                  Accept (manual verification)
                </button>
                <button
                  className="rounded bg-[var(--pl-blocked)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                  disabled={busy === claimId}
                  onClick={() => void confirm(claimId, 'reject')}
                >
                  Reject
                </button>
                <code className="pl-mono self-center text-[11px] text-[var(--pl-muted)]">
                  {claimId}
                </code>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
