import { NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api, clearApiToken, getApiToken, setApiToken, type Org, type Repo, type Run } from './api';
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

const ACTIVE_RUN_STATUSES = ['queued', 'analyzing', 'verifying'];

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
  const [token, setToken] = useState('');
  const [showTokenPanel, setShowTokenPanel] = useState(false);
  const [showRegister, setShowRegister] = useState(false);
  const [newRepo, setNewRepo] = useState({
    provider: 'local',
    owner: '',
    name: '',
    defaultBranch: 'main',
    localPath: '',
  });

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
    let cancelled = false;
    api
      .repositories(orgId)
      .then((r) => {
        if (cancelled) return;
        setRepos(r.data);
        if (r.data[0]) setRepoId(r.data[0].id);
        else setRepoId('');
      })
      .catch((e) => setError(e.message));
    return () => { cancelled = true; };
  }, [orgId]);

  useEffect(() => {
    if (!repoId) {
      setRuns([]);
      setRunId('');
      return;
    }
    let cancelled = false;
    api
      .runs(repoId)
      .then((r) => {
        if (cancelled) return;
        setRuns(r.data);
        setRunId((prev) =>
          prev && r.data.some((x) => x.id === prev) ? prev : (r.data[0]?.id ?? ''),
        );
      })
      .catch((e) => setError(e.message));
    return () => { cancelled = true; };
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

  async function registerRepo() {
    const name = newRepo.name.trim();
    const owner = newRepo.owner.trim();
    if (!name || !owner) {
      setError('Repository owner and name are required.');
      return;
    }
    if (newRepo.provider === 'local' && !newRepo.localPath.trim()) {
      setError('A local path is required for local repositories.');
      return;
    }
    setError(null);
    try {
      const { data } = await api.createRepository({
        provider: newRepo.provider,
        owner,
        name,
        defaultBranch: newRepo.defaultBranch.trim() || 'main',
        ...(newRepo.provider === 'local' ? { localPath: newRepo.localPath.trim() } : {}),
        organizationId: orgId || undefined,
      });
      setRepos((prev) => [data, ...prev.filter((r) => r.id !== data.id)]);
      setRepoId(data.id);
      setShowRegister(false);
      setNewRepo({ provider: 'local', owner: '', name: '', defaultBranch: 'main', localPath: '' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function saveToken() {
    const value = token.trim();
    if (!value) return;
    setApiToken(value);
    setToken('');
    setShowTokenPanel(false);
    // Re-bootstrap the whole view with the authenticated client.
    setLoading(true);
    api
      .organizations()
      .then((r) => {
        setOrgs(r.data);
        setOrgId((prev) => prev || r.data[0]?.id || '');
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  function dropToken() {
    clearApiToken();
    setShowTokenPanel(false);
  }

  async function cancelActiveRun() {
    if (!runId) return;
    setError(null);
    try {
      await api.cancelRun(runId);
      window.dispatchEvent(new CustomEvent('proofloop:run-updated', { detail: { runId } }));
      api
        .runs(repoId)
        .then((r) => setRuns(r.data))
        .catch(() => undefined);
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

  const activeRun = runs.find((r) => r.id === runId);
  const canCancel = Boolean(activeRun && ACTIVE_RUN_STATUSES.includes(activeRun.status));
  const hasStoredToken = Boolean(getApiToken());

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
            {canCancel ? (
              <button
                className="rounded border border-[var(--pl-blocked)] px-3 py-1.5 text-sm text-[var(--pl-blocked)]"
                onClick={() => void cancelActiveRun()}
                title="Cancel the in-flight run"
              >
                Cancel run
              </button>
            ) : null}
            <button
              className="rounded border border-[var(--pl-border)] bg-white px-3 py-1.5 text-sm"
              onClick={() => setShowRegister((v) => !v)}
              disabled={loading}
            >
              Register repository
            </button>
            <button
              className="rounded border border-[var(--pl-border)] bg-white px-3 py-1.5 text-sm"
              onClick={() => void seedDemo()}
              disabled={loading}
            >
              Run demo
            </button>
            <button
              className={`rounded border px-3 py-1.5 text-sm ${
                hasStoredToken
                  ? 'border-[#0f7b4c] text-[#0f7b4c]'
                  : 'border-[var(--pl-border)] text-[var(--pl-muted)]'
              } bg-white`}
              onClick={() => setShowTokenPanel((v) => !v)}
              title="API token — required when the server enforces auth"
            >
              {hasStoredToken ? 'Token ✓' : 'Set token'}
            </button>
          </div>
        </div>
        {showTokenPanel ? (
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 pb-2">
            <input
              className="w-72 rounded border border-[var(--pl-border)] bg-white px-2 py-1 text-sm"
              placeholder="PROOFLOOP_API_TOKEN"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveToken();
              }}
              type="password"
            />
            <button
              className="rounded bg-[#1a2332] px-3 py-1 text-sm text-white"
              onClick={() => void saveToken()}
            >
              Save token
            </button>
            <button
              className="rounded border border-[var(--pl-border)] bg-white px-3 py-1 text-sm"
              onClick={dropToken}
            >
              Clear
            </button>
            <span className="text-xs text-[var(--pl-muted)]">
              Sent as Bearer auth; stored in this browser only.
            </span>
          </div>
        ) : null}
        {showRegister ? (
          <div className="mx-auto flex max-w-6xl flex-wrap items-end gap-2 border-t border-[var(--pl-border)] px-4 py-2">
            <label className="text-xs text-[var(--pl-muted)]">
              Provider
              <select
                className="mt-1 block rounded border border-[var(--pl-border)] bg-white px-2 py-1 text-sm"
                value={newRepo.provider}
                onChange={(e) => setNewRepo((v) => ({ ...v, provider: e.target.value }))}
              >
                <option value="local">local</option>
                <option value="github">github</option>
                <option value="gitlab">gitlab</option>
              </select>
            </label>
            <label className="text-xs text-[var(--pl-muted)]">
              Owner
              <input
                className="mt-1 block w-28 rounded border border-[var(--pl-border)] bg-white px-2 py-1 text-sm"
                value={newRepo.owner}
                onChange={(e) => setNewRepo((v) => ({ ...v, owner: e.target.value }))}
              />
            </label>
            <label className="text-xs text-[var(--pl-muted)]">
              Name
              <input
                className="mt-1 block w-32 rounded border border-[var(--pl-border)] bg-white px-2 py-1 text-sm"
                value={newRepo.name}
                onChange={(e) => setNewRepo((v) => ({ ...v, name: e.target.value }))}
              />
            </label>
            {newRepo.provider === 'local' ? (
              <label className="text-xs text-[var(--pl-muted)]">
                Local path (server-side)
                <input
                  className="mt-1 block w-72 rounded border border-[var(--pl-border)] bg-white px-2 py-1 text-sm"
                  placeholder="/repos/my-project"
                  value={newRepo.localPath}
                  onChange={(e) => setNewRepo((v) => ({ ...v, localPath: e.target.value }))}
                />
              </label>
            ) : (
              <label className="text-xs text-[var(--pl-muted)]">
                Default branch
                <input
                  className="mt-1 block w-24 rounded border border-[var(--pl-border)] bg-white px-2 py-1 text-sm"
                  value={newRepo.defaultBranch}
                  onChange={(e) => setNewRepo((v) => ({ ...v, defaultBranch: e.target.value }))}
                />
              </label>
            )}
            <button
              className="rounded bg-[#1a2332] px-3 py-1.5 text-sm text-white"
              onClick={() => void registerRepo()}
              disabled={loading}
            >
              Create
            </button>
          </div>
        ) : null}
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
          <StatePanel
            state="empty"
            message="Register a repository with “Register repository” above, or load the demo fixture."
          />
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
