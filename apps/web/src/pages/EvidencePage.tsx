import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { StatusBadge, StatusLegend } from '@proofloop/ui';
import { api, type Claim, type EvidencePack, type Verification } from '../api';
import { StatePanel } from '../components/StatePanel';
import { claimEvidenceKind } from '../lib/evidenceKind';

export function EvidencePage() {
  const { runId } = useParams();
  const [claims, setClaims] = useState<Claim[]>([]);
  const [vers, setVers] = useState<Verification[]>([]);
  const [pack, setPack] = useState<EvidencePack | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!runId || runId === '_') return;
    setLoading(true);
    Promise.all([api.claims(runId), api.verifications(runId), api.evidence(runId)])
      .then(([c, v, e]) => {
        setClaims(c.data);
        setVers(v.data);
        setPack(e.data);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [runId]);

  if (!runId || runId === '_') return <StatePanel state="empty" message="Select a run." />;
  if (loading) return <StatePanel state="loading" />;
  if (error) return <StatePanel state="error" message={error} />;
  if (!claims.length) return <StatePanel state="empty" message="No claims for this run." />;

  const headSha = pack?.run.headSha;
  const evidenceVers = (pack?.verifications as Verification[] | undefined) ?? vers;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Evidence</h1>
        <button
          className="rounded border border-[var(--pl-border)] bg-white px-3 py-1 text-xs"
          onClick={() => navigator.clipboard.writeText(JSON.stringify(pack, null, 2))}
        >
          Copy evidence JSON
        </button>
      </div>
      <StatusLegend compact />
      {claims.map((c) => {
        const related = evidenceVers.filter(
          (v) => v.claimId === c.id || v.relatedClaimIds?.includes(c.id),
        );
        const kind = claimEvidenceKind(c, evidenceVers, headSha);
        const expanded = open === c.id;
        return (
          <article key={c.id} className="pl-card">
            <button
              className="flex w-full items-start justify-between gap-3 text-left"
              onClick={() => setOpen(expanded ? null : c.id)}
            >
              <div>
                <div className="font-medium">{c.title}</div>
                <div className="mt-1 text-xs text-[var(--pl-muted)]">
                  {c.category} · {c.source}
                  {kind === 'manual' ? ' · human confirmation (SHA-bound)' : ''}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {c.relatedFiles.map((f) => (
                    <code key={f} className="pl-mono rounded bg-[#f0f3f7] px-1.5 py-0.5 text-[11px]">
                      {f}
                    </code>
                  ))}
                </div>
              </div>
              <StatusBadge status={kind} />
            </button>
            {expanded ? (
              <div className="mt-3 border-t border-[var(--pl-border)] pt-3 text-sm">
                <p className="text-[var(--pl-muted)]">{c.description}</p>
                <div className="mt-3 space-y-2">
                  {related.length === 0 ? (
                    <StatePanel state="partial" message="No linked verifications." />
                  ) : (
                    related.map((v) => (
                      <div key={v.id} className="rounded border border-[var(--pl-border)] p-2">
                        <div className="flex justify-between gap-2">
                          <code className="pl-mono text-xs">{v.command}</code>
                          <StatusBadge
                            status={
                              v.type === 'manual'
                                ? v.status === 'passed'
                                  ? 'manual'
                                  : 'blocked'
                                : v.status
                            }
                          />
                        </div>
                        <div className="mt-1 text-xs text-[var(--pl-muted)]">
                          {v.type}
                          {v.boundHeadSha ? ` · bound ${v.boundHeadSha.slice(0, 12)}` : ''}
                          {v.reviewer ? ` · by ${v.reviewer}` : ''}
                          {' · '}
                          exit {v.exitCode ?? 'n/a'} · {v.durationMs ?? 0}ms
                        </div>
                        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[#f7f8fa] p-2 font-[var(--pl-mono)] text-[11px]">
                          {v.resultSummary}
                        </pre>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
