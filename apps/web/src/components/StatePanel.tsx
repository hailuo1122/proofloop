export function StatePanel({
  state,
  message,
}: {
  state: 'loading' | 'empty' | 'error' | 'partial' | 'completed';
  message?: string;
}) {
  const labels = {
    loading: 'Loading…',
    empty: 'Nothing here yet',
    error: 'Something went wrong',
    partial: 'Partial results available',
    completed: 'Ready',
  };
  return (
    <div className="pl-card text-sm text-[var(--pl-muted)]" data-state={state}>
      <div className="font-medium text-[var(--pl-text)]">{labels[state]}</div>
      {message ? <p className="mt-1">{message}</p> : null}
    </div>
  );
}
