/**
 * Minimal Prometheus text-format metrics registry — no external dependency.
 * Exposes counters/gauges/histograms rendered at `/api/metrics`.
 */

type Labels = Record<string, string>;

class Counter {
  private values = new Map<string, number>();
  constructor(public name: string, public help: string, public labelNames: string[]) {}

  inc(labels: Labels = {}, by = 1) {
    const key = this.labelNames.map((n) => labels[n] ?? '').join('\u0000');
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  render(): string {
    const lines: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.values) {
      const labelValues = key.split('\u0000');
      const labelStr = this.labelNames
        .map((n, i) => `${n}="${escapeLabel(labelValues[i] ?? '')}"`)
        .join(',');
      lines.push(`${this.name}{${labelStr}} ${value}`);
    }
    return lines.join('\n');
  }
}

class Gauge {
  private values = new Map<string, number>();
  constructor(public name: string, public help: string, public labelNames: string[]) {}

  set(labels: Labels, value: number) {
    const key = this.labelNames.map((n) => labels[n] ?? '').join('\u0000');
    this.values.set(key, value);
  }

  render(): string {
    const lines: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [key, value] of this.values) {
      const labelValues = key.split('\u0000');
      const labelStr = this.labelNames
        .map((n, i) => `${n}="${escapeLabel(labelValues[i] ?? '')}"`)
        .join(',');
      lines.push(`${this.name}{${labelStr}} ${value}`);
    }
    return lines.join('\n');
  }
}

class Histogram {
  private bucketsValues = new Map<string, Map<number, number>>();
  private sums = new Map<string, number>();
  private counts = new Map<string, number>();
  constructor(
    public name: string,
    public help: string,
    public labelNames: string[],
    public buckets: number[] = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  ) {}

  observe(labels: Labels, valueSeconds: number) {
    const key = this.labelNames.map((n) => labels[n] ?? '').join('\u0000');
    if (!this.bucketsValues.has(key)) {
      this.bucketsValues.set(key, new Map(this.buckets.map((b) => [b, 0])));
      this.sums.set(key, 0);
      this.counts.set(key, 0);
    }
    const bucketMap = this.bucketsValues.get(key)!;
    for (const b of this.buckets) {
      if (valueSeconds <= b) bucketMap.set(b, (bucketMap.get(b) ?? 0) + 1);
    }
    this.sums.set(key, (this.sums.get(key) ?? 0) + valueSeconds);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  render(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];
    const le = this.buckets;
    for (const [key, bucketMap] of this.bucketsValues) {
      const labelValues = key.split('\u0000');
      const labelStr = this.labelNames
        .map((n, i) => `${n}="${escapeLabel(labelValues[i] ?? '')}"`)
        .join(',');
      for (const b of le) {
        const l = labelStr ? `${labelStr},le="${b}"` : `le="${b}"`;
        lines.push(`${this.name}_bucket{${l}} ${bucketMap.get(b) ?? 0}`);
      }
      const l = labelStr ? `${labelStr},le="+Inf"` : `le="+Inf"`;
      lines.push(`${this.name}_bucket{${l}} ${this.counts.get(key) ?? 0}`);
      lines.push(`${this.name}_sum{${labelStr}} ${this.sums.get(key) ?? 0}`);
      lines.push(`${this.name}_count{${labelStr}} ${this.counts.get(key) ?? 0}`);
    }
    return lines.join('\n');
  }
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Request counter: total requests by route + status. */
export const httpRequests = new Counter('proofloop_http_requests_total', 'HTTP requests processed', [
  'route',
  'method',
  'status',
]);

/** Request duration histogram in seconds. */
export const httpRequestDuration = new Histogram(
  'proofloop_http_request_duration_seconds',
  'HTTP request duration',
  ['route'],
);

/** Runs processed by final status. */
export const runsTotal = new Counter('proofloop_runs_total', 'Change runs finalized', ['status']);

/** Current in-flight runs (queued/analyzing/verifying). */
export const activeRuns = new Gauge('proofloop_active_runs', 'Runs currently in flight', ['status']);

/** Webhook events accepted by provider. */
export const webhooksTotal = new Counter('proofloop_webhooks_total', 'Webhook events processed', [
  'provider',
  'event',
]);

/** LLM usage by operation. */
export const llmTotal = new Counter('proofloop_llm_calls_total', 'LLM calls made', ['op']);

/** Queue depth (BullMQ) when Redis is enabled. */
export const queueDepth = new Gauge('proofloop_queue_depth', 'Pending check jobs', []);

export function renderMetrics(): string {
  return [
    httpRequests.render(),
    httpRequestDuration.render(),
    runsTotal.render(),
    activeRuns.render(),
    webhooksTotal.render(),
    llmTotal.render(),
    queueDepth.render(),
  ]
    .filter(Boolean)
    .join('\n');
}
