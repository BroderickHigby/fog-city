// Counters and a rolling window of room tick times, exposed as Prometheus text at GET /metrics.
export class TickStats {
  private readonly samples: number[] = [];
  private cursor = 0;
  overruns = 0;
  private readonly size: number;
  private readonly budgetMs: number;
  constructor(size = 3600, budgetMs = 1000 / 60) { this.size = size; this.budgetMs = budgetMs; }
  record(ms: number): void {
    if (this.samples.length < this.size) this.samples.push(ms); else { this.samples[this.cursor] = ms; this.cursor = (this.cursor + 1) % this.size; }
    if (ms > this.budgetMs) this.overruns++;
  }
  quantile(q: number): number {
    if (!this.samples.length) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  }
}

export interface MetricsSnapshot {
  [name: string]: { help: string; type: "counter" | "gauge"; value: number | Record<string, number> };
}
/** Prometheus text exposition format (labels only for one-key maps). */
export function prometheus(snapshot: MetricsSnapshot, prefix = "fogcity_relay_"): string {
  const lines: string[] = [];
  for (const name of Object.keys(snapshot).sort()) {
    const m = snapshot[name]!, full = prefix + name;
    lines.push(`# HELP ${full} ${m.help}`, `# TYPE ${full} ${m.type}`);
    if (typeof m.value === "number") lines.push(`${full} ${Number.isFinite(m.value) ? m.value : 0}`);
    else for (const key of Object.keys(m.value).sort()) lines.push(`${full}{label="${key.replace(/[^a-zA-Z0-9_-]/g, "_")}"} ${m.value[key]}`);
  }
  return lines.join("\n") + "\n";
}
