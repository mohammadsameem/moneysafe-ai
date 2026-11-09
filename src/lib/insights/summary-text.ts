/**
 * The deterministic Insights summary: used when no model answer is available (no key, budget
 * reached, outage, invalid answer), and when no cached summary exists. Pure. Plain English, built
 * only from the counts and weights, and never longer than about 120 words.
 */
import { signalLabel } from "@/lib/format";
import type { InsightsSummaryInput } from "./types";
import { BASELINE_WEIGHTS, PROPOSAL_EVERY, weightChanges, type WeightChange } from "./weights";

const describe = (c: WeightChange): string => `${signalLabel(c.signal).toLowerCase()} ${c.from} to ${c.to}`;

export function ruleBasedInsightsSummary(input: InsightsSummaryInput): string {
  const { stats, current, proposed, counter } = input;
  const parts: string[] = [];

  if (stats.total === 0) {
    parts.push("No disputes have been resolved yet, so there is nothing to learn from.");
  } else {
    const simulated = stats.simulated > 0 ? ` (${stats.simulated} recorded as simulated outcomes)` : "";
    parts.push(`Of the ${stats.total} resolved disputes, ${stats.won} were won, ${stats.lost} lost and ${stats.refunded} ended in refunds${simulated}.`);
  }

  const drift = weightChanges(BASELINE_WEIGHTS, current);
  parts.push(drift.length === 0 ? "All six signal weights are at their starting values." : `Weights now differ from the starting values: ${drift.map(describe).join("; ")}.`);

  if (proposed) {
    const pending = weightChanges(current, proposed);
    parts.push(
      pending.length > 0
        ? `One change is waiting for your review: ${pending.map(describe).join("; ")}. Nothing changes until you approve it.`
        : "A proposal is waiting for your review, but it changes nothing.",
    );
  } else {
    const remaining = PROPOSAL_EVERY - (counter % PROPOSAL_EVERY);
    parts.push(`No weight change is pending. A new proposal is considered after every ${PROPOSAL_EVERY} resolved disputes (${remaining} more to go).`);
  }
  return parts.join(" ");
}
