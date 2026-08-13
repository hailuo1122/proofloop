import { useEffect, useState } from 'react';
import { api, type RuleDraft } from '../api';
import { StatePanel } from '../components/StatePanel';

const defaultDraft: RuleDraft[] = [
  {
    key: 'block-risk',
    description: 'Block merge on unresolved high/critical risk',
    ruleType: 'security',
    config: {
      blockOn: ['critical', 'high'],
      requireDynamicVerificationFor: ['security', 'data', 'compatibility'],
    },
    enabled: true,
  },
  {
    key: 'command-policy',
    description: 'Network disabled for verify commands',
    ruleType: 'command_policy',
    config: { allowNetwork: false },
    enabled: true,
  },
];

export function RulesPage({ repoId }: { repoId: string }) {
  const [draft, setDraft] = useState('');
  const [impact, setImpact] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!repoId) return;
    api
      .rules(repoId)
      .then((r) => {
        const mapped = r.data.map(({ key, description, ruleType, config, enabled }) => ({
          key,
          description,
          ruleType,
          config,
          enabled,
        }));
        setDraft(JSON.stringify(mapped.length ? mapped : defaultDraft, null, 2));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [repoId]);

  if (!repoId) return <StatePanel state="empty" message="Select a repository." />;
  if (loading) return <StatePanel state="loading" />;
  if (error) return <StatePanel state="error" message={error} />;

  async function preview() {
    setError(null);
    try {
      const parsed = JSON.parse(draft) as RuleDraft[];
      const res = await api.previewRules(repoId, parsed);
      setImpact(res.data.changes);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid JSON');
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const parsed = JSON.parse(draft) as RuleDraft[];
      const res = await api.putRules(repoId, parsed);
      setImpact([
        'Saved. Next check uses these policies (also synced to proofloop.yml when localPath exists).',
        ...(res.data.changes ?? []),
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <h1 className="text-lg font-semibold">Rules</h1>
      <p className="text-sm text-[var(--pl-muted)]">
        These rules merge into <code className="pl-mono text-xs">proofloop.yml</code> policies
        (`blockOn`, `requireDynamicVerificationFor`, `allowNetwork`, commands). Preview the merge-gate
        delta before saving — they take effect on the next check.
      </p>
      <textarea
        className="h-72 w-full rounded border border-[var(--pl-border)] bg-white p-3 font-[var(--pl-mono)] text-xs"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      {impact ? (
        <div className="pl-card text-sm">
          <div className="text-xs uppercase text-[var(--pl-muted)]">Policy impact</div>
          <ul className="mt-2 list-disc pl-5">
            {impact.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex gap-2">
        <button
          className="rounded border border-[var(--pl-border)] bg-white px-3 py-1.5 text-sm"
          onClick={() => void preview()}
        >
          Preview impact
        </button>
        <button
          className="rounded bg-[#1a2332] px-3 py-1.5 text-sm text-white disabled:opacity-50"
          disabled={saving}
          onClick={() => void save()}
        >
          Save rules
        </button>
      </div>
    </div>
  );
}
