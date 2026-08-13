import { evidenceKindLabel } from './StatusLegend.js';

export function StatusBadge({
  status,
  title,
}: {
  status: string;
  title?: string;
}) {
  const label = evidenceKindLabel(status);
  return (
    <span className="pl-status" data-status={status} title={title ?? label}>
      {label}
    </span>
  );
}
