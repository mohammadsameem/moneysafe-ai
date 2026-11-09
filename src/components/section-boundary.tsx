"use client";

import { Component, type ReactNode } from "react";
import { ErrorCard } from "@/components/ui/error-card";

interface Props {
  /** The section's name, for "We could not show the decision panel." */
  what: string;
  children: ReactNode;
}

interface State {
  failed: boolean;
  attempt: number;
}

/**
 * Section-level error boundary: if one widget fails to render, that widget becomes an error card
 * with a Try again button and the rest of the page keeps working. (A server-side failure of the
 * whole page is handled by app/(app)/error.tsx.)
 */
export class SectionBoundary extends Component<Props, State> {
  state: State = { failed: false, attempt: 0 };

  // Nothing is logged from here: the error text can carry data, and the server log has the real failure.
  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <ErrorCard compact what={`the ${this.props.what}`} onRetry={() => this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }))} />;
    }
    // A new key remounts the children on retry, so a transient render failure can clear.
    return <div key={this.state.attempt}>{this.props.children}</div>;
  }
}
