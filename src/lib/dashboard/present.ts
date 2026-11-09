/** Display helpers for the dashboard. Pure, so they are unit-tested without a browser. */

export type VerdictKey = "ship" | "verify" | "hold";

export interface DonutSegment {
  key: VerdictKey;
  label: string;
  count: number;
  /** Whole percent of all scored orders (0 when there are none). */
  percent: number;
  /** SVG stroke-dasharray "length gap" on a circle whose circumference is 100. */
  dashArray: string;
  /** SVG stroke-dashoffset: where the segment starts, measured from 12 o'clock. */
  dashOffset: number;
  /** Stroke colour (hex). The legend repeats the meaning in words. */
  color: string;
}

const META: Record<VerdictKey, { label: string; color: string }> = {
  ship: { label: "Ship", color: "#16a34a" },
  verify: { label: "Verify first", color: "#f59e0b" },
  hold: { label: "Hold", color: "#dc2626" },
};

/**
 * Segments for a donut drawn with `stroke-dasharray` on a circle of circumference 100 (r = 100 / 2π).
 * A verdict with no orders gets no arc, so an empty distribution draws nothing.
 */
export function donutSegments(counts: Record<VerdictKey, number>): DonutSegment[] {
  const keys: VerdictKey[] = ["ship", "verify", "hold"];
  const total = keys.reduce((n, k) => n + counts[k], 0);
  let drawn = 0;
  return keys.map((key) => {
    const count = counts[key];
    const length = total === 0 ? 0 : (count / total) * 100;
    const segment: DonutSegment = {
      key,
      label: META[key].label,
      count,
      percent: total === 0 ? 0 : Math.round((count / total) * 100),
      dashArray: `${length} ${100 - length}`,
      // Rotated -90deg in the SVG so 0 is 12 o'clock; each arc starts where the previous one ended.
      dashOffset: -drawn,
      color: META[key].color,
    };
    drawn += length;
    return segment;
  });
}

/** One sentence for screen readers. */
export function donutSummary(counts: Record<VerdictKey, number>): string {
  const total = counts.ship + counts.verify + counts.hold;
  if (total === 0) return "No scored orders yet.";
  return `Risk distribution of ${total} scored orders: ${counts.ship} Ship, ${counts.verify} Verify first, ${counts.hold} Hold.`;
}
