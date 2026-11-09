import { NextResponse } from "next/server";
import type { DecideResult } from "./decide";

/** The error response for a decision that could not be applied, or null when it succeeded. */
export function decisionRefusal(result: DecideResult): NextResponse | null {
  switch (result.kind) {
    case "no_proposal":
      return NextResponse.json({ error: "no_proposal", message: "There is no pending weight proposal. It may already have been decided." }, { status: 409 });
    case "proposal_changed":
      return NextResponse.json({ error: "proposal_changed", message: "A different proposal is pending now. Reload the page to see it." }, { status: 409 });
    case "not_seeded":
      return NextResponse.json({ error: "not_seeded", message: "The demo data has not been loaded. Run the seed." }, { status: 503 });
    default:
      return null;
  }
}
