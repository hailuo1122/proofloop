import { NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api, type Org, type Repo, type Run } from './api';
import { OverviewPage } from './pages/OverviewPage';
import { EvidencePage } from './pages/EvidencePage';
import { UnknownsPage } from './pages/UnknownsPage';
import { ImpactPage } from './pages/ImpactPage';
import { HistoryPage } from './pages/HistoryPage';
import { RulesPage } from './pages/RulesPage';
import { StatePanel } from './components/StatePanel';

const nav = [
  ['', 'Overview'],
  ['evidence', 'Evidence'],
  ['unknowns', 'Unknowns'],
  ['impact', 'Impact Graph'],
  ['history', 'History'],
  ['rules', 'Rules'],
] as const;

export default function App() {
  const navigate = useNavigate();
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [orgId, setOrgId] = useState<string>('');
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoId, setRepoId] = useState<string>('');
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [orgName, setOrgName] = useState('');

  useEffect(() => {
    api
      .organizations()
      .then((r) => {
        setOrgs(r.data);
        setOrgId(r.data[0]?.id ?? '');
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!orgId) {
      setRepos([]);
      setRepoId('');
      return;
    }
    api
      .repositories(orgId)
      .then((r) => {
        setRepos(r.data);
        if (r.data[0]) setRepoId(r.data[0].id);
        else setRepoId('');
      })
      .catch((e) => setError(e.message));
  }, [orgId]);

  useEffect(() => {
    if (!repoId) return;
    api
      .runs(repoId)
      .then((r) => {
        setRuns(r.data);
        setRunId((prev) =>
          prev && r.data.some((x) => x.id === prev) ? prev : (r.data[0]?.id ?? ''),
        );
      })
      .catch((e) => setError(e.message));
  }, [repoId]);

  useEffect(() => {
    if (!repoId) return;
    const onUpdate = () => {
      api
        .runs(repoId)
        .then((r) => setRuns(r.data))
        .catch(() => undefined);
    };
    window.addEventListener('proofloop:run-updated', onUpdate);
    return () => window.removeEventListener('proofloop:run-updated', onUpdate);
  }, [repoId]);

  async function seedDemo() {
    setError(null);
    setLoading(true);
    try {
      const res = await api.bootstrapDemo(true);
      setRepos((prev) => {
        const others = prev.filter((r) => r.id !== res.data.repository.id);
        return [res.data.repository, ...others];
      });
      setRepoId(res.data.repository.id);
      if (res.data.run) {
        setRuns((prev) => [res.data.run!, ...prev.filter((r) => r.id !== res.data.run!.id)]);
        setRunId(res.data.run.id);
        navigate(`/runs/${res.data.run.id}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function createOrg() {
    const name = orgName.trim();
    if (!name) return;
    setError(null);
    try {
      const { data } = await api.createOrganization({ name });
      setOrgs((prev) => [...prev, data]);
      setOrgId(data.id);
      setOrgName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function runCheck() {
    if (!repoId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.createRun(repoId, {
        noLlm: true,
        base: 'HEAD~1',
        head: 'HEAD',
        sync: false,
      });
      setRuns((prev) => [res.data, ...prev.filter((r) => r.id !== res.data.id)]);
      setRunId(res.data.id);
      navigate(`/runs/${res.data.id}`);
      let current = res.data;
      for (let i = 0; i < 180; i++) {
        if (['completed', 'failed', 'cancelled'].includes(current.status)) break;
        await new Promise((r) => setTimeout(r, 500));
        current = (await api.run(current.id)).data;
        setRuns((prev) => [current, ...prev.filter((r) => r.id !== current.id)]);
      }
      window.dispatchEvent(
        new CustomEvent('proofloop:run-updated', { detail: { runId: current.id } }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-full">
      <header className="border-b border-[var(--pl-border)] bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <div>
            <div className="text-lg font-semibold tracking-tight">ProofLoop</div>
            <div className="text-xs text-[var(--pl-muted)]">Evidence-first change verification</div>
          </div>
          <div className="flex items-center gap-2">
            <select
              className="rounded border border-[var(--pl-border)] bg-white px-2 py-1 text-sm"
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
              title="Organization (tenant)"
            >
              <option value="">Select org</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <input
              className="w-36 rounded border border-[var(--pl-border)] bg-white px-2 py-1 text-sm"
              placeholder="New org name"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createOrg();
              }}
            />
            <button
              className="rounded border border-[var(--pl-border)] bg-white px-3 py-1.5 text-sm"
              onClick={() => void createOrg()}
              disabled={loading}
            >
              New org
            </button>
            <select
              className="rounded border border-[var(--pl-border)] bg-white px-2 py-1 text-sm"
              value={repoId}
              onChange={(e) => setRepoId(e.target.value)}
            >
              <option value="">Select repository</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.owner}/{r.name}
                </option>
              ))}
            </select>
            <select
              className="rounded border border-[var(--pl-border)] bg-white px-2 py-1 font-[var(--pl-mono)] text-xs"
              value={runId}
              onChange={(e) => {
                const id = e.target.value;
                setRunId(id);
                if (id) navigate(`/runs/${id}`);
              }}
            >
              <option value="">Select run</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id.slice(0, 16)}… {r.overallStatus ?? r.status}
                </option>
              ))}
            </select>
            <button
              className="rounded bg-[#1a2332] px-3 py-1.5 text-sm text-white"
              onClick={() => void runCheck()}
            >
              Run check
            </button>
            <button
              className="rounded border border-[var(--pl-border)] bg-white px-3 py-1.5 text-sm"
              onClick={() => void seedDemo()}
              disabled={loading}
            >
              Run demo
            </button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-6xl gap-4 px-4 pb-2 text-sm">
          {nav.map(([path, label]) => (
            <NavLink
              key={path}
              to={path ? `/runs/${runId || '_'}/${path}` : `/runs/${runId || '_'}`}
              className={({ isActive }) =>
                `pb-1 ${isActive ? 'border-b-2 border-[#1a2332] font-medium' : 'text-[var(--pl-muted)]'}`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {error ? <StatePanel state="error" message={error} /> : null}
        {loading && !runId ? <StatePanel state="loading" /> : null}
        {!loading && !repoId ? (
          <StatePanel state="empty" message="Register a repository or the demo fixture to begin." />
        ) : null}
        <Routes>
          <Route path="/" element={<StatePanel state="empty" message="Select a run from the header." />} />
          <Route path="/runs/:runId" element={<OverviewPage />} />
          <Route path="/runs/:runId/evidence" element={<EvidencePage />} />
          <Route path="/runs/:runId/unknowns" element={<UnknownsPage />} />
          <Route path="/runs/:runId/impact" element={<ImpactPage />} />
          <Route path="/runs/:runId/history" element={<HistoryBridge repoId={repoId} />} />
          <Route path="/runs/:runId/rules" element={<RulesBridge repoId={repoId} />} />
        </Routes>
      </main>
    </div>
  );
}

function HistoryBridge({ repoId }: { repoId: string }) {
  return <HistoryPage repoId={repoId} />;
}

function RulesBridge({ repoId }: { repoId: string }) {
  const { runId } = useParams();
  void runId;
  return <RulesPage repoId={repoId} />;
}
