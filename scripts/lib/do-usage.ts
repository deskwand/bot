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
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const className = value("--objects");
  if (!className) return { days: 3 };
  return {
    days: 3,
    objects: { className, date: value("--date") ?? new Date().toISOString().slice(0, 10) },
  };
}
