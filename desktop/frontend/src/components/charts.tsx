import { cn } from "@/lib/utils";

/**
 * Small charts drawn with boxes and CSS variables. The desktop bundle ships
 * inside the Go binary, so a chart library would cost more than it gives: these
 * primitives follow the theme through the shared tokens and animate with
 * `transition`, and every one of them keeps the number in the text beside it.
 */
export type ChartTone = "primary" | "primarySoft" | "emerald" | "amber" | "red" | "muted";

const TONE: Record<ChartTone, string> = {
  primary: "bg-primary",
  primarySoft: "bg-primary/45",
  emerald: "bg-emerald-600",
  amber: "bg-amber-500",
  red: "bg-red-600",
  muted: "bg-muted-foreground/40",
};

const EASE = "transition-[width,height] duration-500 ease-out motion-reduce:transition-none";

/**
 * A value's 0-1 share of the largest value. A small non-zero value keeps a
 * sliver, so "barely anything" never renders as "nothing".
 */
function shareOf(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || value <= 0 || max <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(value / max, 0.03));
}

/**
 * A labelled chart needs `label`; without one the shape restates a number that
 * is already on screen, so it is hidden from assistive tech instead of read
 * twice.
 */
function chartProps(label: string | undefined) {
  return label === undefined
    ? { "aria-hidden": true as const }
    : { role: "img" as const, "aria-label": label };
}

/** A horizontal bar for one value against a scale: spend by source, runway, totals. */
export function Bar({ value, max, tone = "primary" }: { value: number; max: number; tone?: ChartTone }) {
  return (
    <div aria-hidden className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn("h-full rounded-full", EASE, TONE[tone])}
        style={{ width: `${(shareOf(value, max) * 100).toFixed(2)}%` }}
      />
    </div>
  );
}

export type ChartCell = { key: string; tone: ChartTone; title?: string };

/** One strip of cells in time order: bot runs, health checks. */
export function CellStrip({
  cells,
  label,
  className,
}: {
  cells: ChartCell[];
  label?: string;
  className?: string;
}) {
  return (
    <div {...chartProps(label)} className={cn("flex flex-wrap items-end gap-1", className)}>
      {cells.map((cell) => (
        <span
          key={cell.key}
          title={cell.title}
          className={cn("h-4 w-1.5 rounded-[2px]", TONE[cell.tone])}
        />
      ))}
    </div>
  );
}

export type ChartColumn = { key: string; value: number; tone?: ChartTone; title?: string };

/** Columns on a shared baseline, left to right: one column per backup file. */
export function ColumnChart({
  columns,
  label,
  className,
}: {
  columns: ChartColumn[];
  label?: string;
  className?: string;
}) {
  const max = Math.max(...columns.map((column) => column.value), 0);
  return (
    <div
      {...chartProps(label)}
      className={cn("flex h-16 items-end gap-1.5 border-b border-border", className)}
    >
      {columns.map((column) => (
        <span
          key={column.key}
          title={column.title}
          className={cn(
            "min-w-1 max-w-10 flex-1 rounded-t-[2px]",
            EASE,
            TONE[column.tone ?? "primary"],
          )}
          style={{ height: `${Math.max(shareOf(column.value, max) * 100, 3).toFixed(2)}%` }}
        />
      ))}
    </div>
  );
}
