const ROWS = [
  {
    status: 'verified',
    label: 'verified',
    meaning: 'Claim linked to an executed check that passed (unit/integration/security). Not AI opinion.',
  },
  {
    status: 'passed',
    label: 'passed',
    meaning: 'Broader suite association passed; weaker than a directly linked verification.',
  },
  {
    status: 'manual',
    label: 'manual verification',
    meaning: 'Human accept bound to a specific commit SHA. New commits invalidate it automatically.',
  },
  {
    status: 'inferred',
    label: 'inferred',
    meaning: 'Heuristic or LLM-only. Never counts as verified evidence.',
  },
  {
    status: 'unknown',
    label: 'unknown',
    meaning: 'No sufficient executed evidence. High-risk unknowns block merge.',
  },
  {
    status: 'blocked',
    label: 'blocked',
    meaning: 'Verification failed, policy blocked, or human rejected.',
  },
] as const;

export function StatusLegend({ compact = false }: { compact?: boolean }) {
  return (
    <section className="pl-legend" aria-label="Claim status legend">
      {!compact ? <h2 className="pl-legend__title">Status meanings</h2> : null}
      <ul className="pl-legend__list">
        {ROWS.map((row) => (
          <li key={row.status} className="pl-legend__item">
            <span className="pl-status" data-status={row.status}>
              {row.label}
            </span>
            <span className="pl-legend__meaning">{row.meaning}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function evidenceKindLabel(kind: string): string {
  if (kind === 'manual') return 'manual verification';
  if (ROWS.some((r) => r.status === kind)) return kind;
  return kind.replace(/_/g, ' ');
}
