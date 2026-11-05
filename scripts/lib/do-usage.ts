/** Pure helpers for scripts/do-usage.ts, unit-tested in tests-node/do-usage.test.ts. */

export type UsageRow = {
  date: string;
  namespaceId: string;
  rowsWritten: number;
  rowsRead: number;
  activeTime: number;
};

export type DayUsage = {
  date: string;
  byClass: Array<{ className: string; rowsWritten: number; rowsRead: number; activeTime: number }>;
  totalWritten: number;
  pctOfFree: number;
};

const FREE_DAILY_ROWS_WRITTEN = 100_000;

/** Reads oauth_token from the text of a wrangler config.toml; returns null when absent. */
export function readOAuthToken(toml: string): string | null {
  const match = /^\s*oauth_token\s*=\s*"([^"]*)"/m.exec(toml);
  return match?.[1] || null;
}

/** Groups rows by date, maps namespace ids to class names, and sorts classes by writes. */
export function summarize(rows: UsageRow[], classes: Record<string, string>): DayUsage[] {
  const byDate = new Map<string, Map<string, UsageRow>>();
  for (const row of rows) {
    const className = classes[row.namespaceId] ?? row.namespaceId;
    let grouped = byDate.get(row.date);
    if (!grouped) {
      grouped = new Map();
      byDate.set(row.date, grouped);
    }
    const existing = grouped.get(className);
    if (existing) {
      existing.rowsWritten += row.rowsWritten;
      existing.rowsRead += row.rowsRead;
      existing.activeTime += row.activeTime;
    } else {
      grouped.set(className, { ...row });
    }
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, grouped]) => {
      const byClass = [...grouped.entries()]
        .map(([className, row]) => ({
          className,
          rowsWritten: row.rowsWritten,
          rowsRead: row.rowsRead,
          activeTime: row.activeTime,
        }))
        .sort((a, b) => b.rowsWritten - a.rowsWritten);
      const totalWritten = byClass.reduce((sum, row) => sum + row.rowsWritten, 0);
      return {
        date,
        byClass,
        totalWritten,
        pctOfFree: (totalWritten / FREE_DAILY_ROWS_WRITTEN) * 100,
      };
    });
}

export function parseArgs(argv: string[]): {
  days: number;
  objects?: { className: string; date: string };
} {
  let days = 3;
  let className: string | undefined;
  let date: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--days") {
      const parsed = Number(argv[index + 1]);
      index += 1;
      if (Number.isFinite(parsed) && parsed > 0) days = Math.floor(parsed);
    } else if (arg.startsWith("--days=")) {
      const parsed = Number(arg.slice("--days=".length));
      if (Number.isFinite(parsed) && parsed > 0) days = Math.floor(parsed);
    } else if (arg === "--objects") {
      className = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--objects=")) {
      className = arg.slice("--objects=".length);
    } else if (arg === "--date") {
      date = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--date=")) {
      date = arg.slice("--date=".length);
    }
  }

  if (!className) return { days };
  return {
    days,
    objects: { className, date: date ?? new Date().toISOString().slice(0, 10) },
  };
}
