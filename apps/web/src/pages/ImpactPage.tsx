import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api, type ImpactEdge, type ImpactNode } from '../api';
import { StatePanel } from '../components/StatePanel';

export function ImpactPage() {
  const { runId } = useParams();
  const [nodesRaw, setNodesRaw] = useState<ImpactNode[]>([]);
  const [edgesRaw, setEdgesRaw] = useState<ImpactEdge[]>([]);
  const [note, setNote] = useState('');
  const [riskFilter, setRiskFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!runId || runId === '_') return;
    api
      .impact(runId)
      .then((r) => {
        setNodesRaw(r.data.nodes);
        setEdgesRaw(r.data.edges ?? []);
        setNote(r.data.coverageNote);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [runId]);

  const filtered = useMemo(
    () =>
      nodesRaw.filter(
        (n) =>
          (riskFilter === 'all' || n.riskLevel === riskFilter) &&
          (typeFilter === 'all' || n.nodeType === typeFilter),
      ),
    [nodesRaw, riskFilter, typeFilter],
  );

  const { nodes, edges } = useMemo(() => {
    const visible = new Set(filtered.slice(0, 80).map((n) => n.id));
    const nodes: Node[] = filtered.slice(0, 80).map((n, i) => ({
      id: n.id,
      position: { x: (i % 5) * 220, y: Math.floor(i / 5) * 120 },
      data: {
        label: `${n.label}\n[${n.nodeType}/${n.relation}]\nsrc=${n.source ?? '?'} conf=${n.confidence ?? '?'}`,
      },
      style: {
        fontFamily: 'var(--pl-mono)',
        fontSize: 11,
        whiteSpace: 'pre-wrap',
        width: 200,
        border:
          n.riskLevel === 'high' || n.riskLevel === 'critical'
            ? '1px solid #cf222e'
            : '1px solid #d9dee7',
        background: '#fff',
      },
    }));

    const fromServer: Edge[] = edgesRaw
      .filter((e) => {
        const from = String(e.from);
        const to = String(e.to);
        return visible.has(from) && visible.has(to);
      })
      .map((e) => ({
        id: e.id ?? `${e.from}-${e.to}`,
        source: String(e.from),
        target: String(e.to),
        label: e.relation,
        style: { stroke: '#8b95a5' },
      }));

    if (fromServer.length) return { nodes, edges: fromServer };

    // Legacy fallback: path-matched edges
    const legacy: Edge[] = [];
    const files = filtered.filter((n) => n.nodeType === 'file');
    for (const f of files) {
      for (const n of filtered) {
        if (n.path === f.path && n.id !== f.id && visible.has(n.id)) {
          legacy.push({ id: `${f.id}-${n.id}`, source: f.id, target: n.id });
        }
      }
    }
    return { nodes, edges: legacy };
  }, [filtered, edgesRaw]);

  if (!runId || runId === '_') return <StatePanel state="empty" message="Select a run." />;
  if (loading) return <StatePanel state="loading" />;
  if (error) return <StatePanel state="error" message={error} />;
  if (!nodesRaw.length) return <StatePanel state="empty" message="No impact nodes." />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Impact Graph</h1>
        <div className="flex gap-2 text-sm">
          <select
            className="rounded border border-[var(--pl-border)] bg-white px-2 py-1"
            value={riskFilter}
            onChange={(e) => setRiskFilter(e.target.value)}
          >
            <option value="all">All risks</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="critical">critical</option>
          </select>
          <select
            className="rounded border border-[var(--pl-border)] bg-white px-2 py-1"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          >
            <option value="all">All types</option>
            <option value="file">file</option>
            <option value="symbol">symbol</option>
            <option value="test">test</option>
            <option value="dependency">dependency</option>
          </select>
        </div>
      </div>
      <p className="text-xs text-[var(--pl-muted)]">
        {note} · edges: {edges.length}
      </p>
      <div className="h-[480px] rounded border border-[var(--pl-border)] bg-white">
        <ReactFlow nodes={nodes} edges={edges} fitView>
          <Background />
          <MiniMap />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}
