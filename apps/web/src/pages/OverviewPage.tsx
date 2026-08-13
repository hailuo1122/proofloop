import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { StatusBadge, StatusLegend } from '@proofloop/ui';
import { api, type EvidencePack, type Run } from '../api';
// api.cancelRun used for in-flight async checks
import { StatePanel } from '../components/StatePanel';
import { activeReviews, claimEvidenceKind, rejectedReviews } from '../lib/evidenceKind';

export function OverviewPage() {
  const { runId } = useParams();
  const [run, setRun] = useState<Run | null>(null);
  const [pack, setPack] = useState<EvidencePack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!runId || runId === '_') return;
    let cancelled = false;
    function load(showSpinner: boolean) {
      if (showSpinner) setLoading(true);
      api
        .run(runId!)
        .then(async (r) => {
          if (cancelled) return;
          setRun(r.data);
          const inflight = ['queued', 'analyzing', 'verifying'].includes(r.data.status);
          try {
            const e = await api.evidence(runId!);
            if (!cancelled) {
              setPack(e.data);
              setError(null);
            }
          } catch (err) {
            if (!cancelled) {
              setPack(null);
              if (!inflight) {
                setError(
                  r.data.errorCode
                    ? `Run ${r.data.status}: ${r.data.errorCode}`
                    : err instanceof Error
                      ? err.message
                      : String(err),
                );
              } else {
                setError(null);
              }
            }
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err.message);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }
    load(true);
    const onUpdate = (ev: Event) => {
      const detail = (ev as CustomEvent<{ runId?: string }>).detail;
      if (!detail?.runId || detail.runId === runId) load(false);
    };
    window.addEventListener('proofloop:run-updated', onUpdate);
    const poll = window.setInterval(() => {
      load(false);
    }, 2500);
    return () => {
      cancelled = true;
      window.removeEventListener('proofloop:run-updated', onUpdate);
      window.clearInterval(poll);
    };
  }, [runId]);

  if (!runId || runId === '_') return <StatePanel state="empty" message="Select a run." />;
  if (loading && !run) return <StatePanel state="loading" />;
  if (error && !run) return <StatePanel state="error" message={error} />;
  if (!run) return <StatePanel state="partial" message="Run metadata incomplete." />;
  if (!pack) {
    if (error) {
      return <StatePanel state="error" message={error} />;
    }
    return (
      <div className="space-y-3">
        <StatePanel
          state="loading"
          message={`Run ${run.status}${run.phase ? ` · ${run.phase}` : ''} — evidence not ready yet`}
        />
        {run.cancellable ? (
          <button
            className="rounded border border-[var(--pl-border)] px-3 py-1.5 text-sm"
            onClick={() =>
              void api
                .cancelRun(run.id)
                .then(() =>
                  window.dispatchEvent(
                    new CustomEvent('proofloop:run-updated', { detail: { runId: run.id } }),
                  ),
                )
                .catch((err) => setError(err instanceof Error ? err.message : String(err)))
            }
          >
            Cancel run
          </button>
        ) : null}
      </div>
    );
  }

  const unknowns = pack.unknowns?.length ?? 0;
  const highRisk = pack.claims.filter((c) => (c.riskWeight ?? 0) >= 70);
  const reviews = activeReviews(pack);
  const rejects = rejectedReviews(pack);

  return (
    <div className="space-y-4">
      <section className="pl-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-[var(--pl-muted)]">Change run</div>
            <h1 className="mt-1 font-[var(--pl-mono)] text-lg">{run.id}</h1>
            <div className="mt-2 flex flex-wrap gap-3 text-sm text-[var(--pl-muted)]">
              <span>
                {run.baseSha.slice(0, 8)} → {run.headSha.slice(0, 8)}
              </span>
              <span>{run.totalDurationMs ?? pack.run.totalDurationMs ?? '—'} ms</span>
              <span>risk: {run.riskLevel}</span>
              {run.phase ? <span>phase: {run.phase}</span> : null}
            </div>
          </div>
          <div className="text-right">
            <StatusBadge status={run.overallStatus ?? run.status} title="Overall run status" />
            <div className="mt-2 text-sm">
              Merge:{' '}
              <strong>
                {pack.mergeGate
                  ? pack.mergeGate.allowMerge
                    ? 'allowed'
                    : 'blocked'
                  : 'unknown'}
              </strong>
            </div>
            <div className="max-w-sm text-xs text-[var(--pl-muted)]">
              {pack.mergeGate?.reason ?? 'Merge gate not present on this pack'}
            </div>
            {run.cancellable ? (
              <button
                className="mt-3 rounded border border-[var(--pl-border)] px-2 py-1 text-xs"
                onClick={() =>
                  void api.cancelRun(run.id).then(() =>
                    window.dispatchEvent(
                      new CustomEvent('proofloop:run-updated', { detail: { runId: run.id } }),
                    ),
                  )
                }
              >
                Cancel run
              </button>
            ) : null}
          </div>
        </div>
      </section>

      <StatusLegend />

      <section className="pl-card">
        <h2 className="text-sm font-semibold">What this change intends</h2>
        <p className="mt-2 text-sm leading-relaxed">{pack.intent.summary}</p>
        {pack.intent.assumptions?.length ? (
          <ul className="mt-2 list-disc pl-5 text-xs text-[var(--pl-muted)]">
            {pack.intent.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="grid gap-3 sm:grid-cols-4">
        {[
          ['Claims', pack.claims.length],
          ['Verifications', pack.verifications?.length ?? 0],
          ['Unknowns', unknowns],
          ['High-risk claims', highRisk.length],
        ].map(([label, value]) => (
          <div key={String(label)} className="pl-card">
            <div className="text-xs text-[var(--pl-muted)]">{label}</div>
            <div className="mt-1 text-2xl font-semibold">{value}</div>
          </div>
        ))}
      </section>

      {reviews.length ? (
        <section className="pl-card">
          <h2 className="text-sm font-semibold">Human reviews (SHA-bound)</h2>
          <ul className="mt-2 space-y-2 text-sm">
            {reviews.map((r) => (
              <li key={r.id} className="rounded border border-[var(--pl-border)] p-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <StatusBadge status={r.decision === 'accept' ? 'manual' : 'blocked'} />
                  <code className="pl-mono text-[11px]">{r.headSha.slice(0, 12)}</code>
                </div>
                <div className="mt-1 text-xs text-[var(--pl-muted)]">
                  claim `{r.claimId}` · {r.reviewer} · {r.at}
                </div>
                {r.note ? <p className="mt-1 text-sm">Reason: {r.note}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {rejects.length ? (
        <section className="pl-card border-[color:var(--pl-blocked)]">
          <h2 className="text-sm font-semibold text-[var(--pl-blocked)]">Rejected claims</h2>
          <p className="mt-1 text-xs text-[var(--pl-muted)]">
            Fix the issue, then re-run check on the new commit. Prior accepts on old SHAs do not
            carry forward.
          </p>
          <ul className="mt-2 space-y-2 text-sm">
            {rejects.map((r) => (
              <li key={r.id}>
                <div className="font-medium">{r.claimId}</div>
                <div className="text-xs text-[var(--pl-muted)]">
                  {r.reviewer} · {r.note || 'No reason provided'}
                </div>
              </li>
            ))}
          </ul>
          <Link
            className="mt-3 inline-block text-sm underline"
            to={`/runs/${runId}/unknowns`}
          >
            Open Unknowns / re-run from header
          </Link>
        </section>
      ) : null}

      {highRisk.length ? (
        <section className="pl-card border-[color:var(--pl-blocked)]">
          <h2 className="text-sm font-semibold text-[var(--pl-blocked)]">High-risk areas</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {highRisk.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2">
                <span>{c.title}</span>
                <StatusBadge
                  status={claimEvidenceKind(c, pack.verifications ?? [], pack.run.headSha)}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
