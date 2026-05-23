// ErrorBoundary — catches uncaught render errors from anywhere in
// the tree and renders a styled fallback instead of blanking the
// page. Without this, React 18 unmounts the entire root on any
// uncaught error, leaving the user staring at an empty cream canvas
// with no explanation.
//
// Class component (no hook equivalent for componentDidCatch yet).
// Renders different fallbacks in dev (with stack trace, for
// debuggability) vs prod (calm apology + Retry button).

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Override the fallback rendering. Receives error + reset fn. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("[ea.error-boundary] uncaught render error:", error, info);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      return <DefaultFallback error={this.state.error} onReset={this.reset} />;
    }
    return this.props.children;
  }
}

function DefaultFallback({
  error,
  onReset,
}: {
  error: Error;
  onReset: () => void;
}) {
  // Vite injects `import.meta.env.DEV` (true in dev server / pnpm dev,
  // false in `pnpm build` output and in the bundled .hebbsmod consumed
  // by the BoringOS shell). We show the stack only in dev so a curious
  // end-user doesn't see internals in prod.
  const isDev = import.meta.env.DEV;

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "32px",
        backgroundColor: "var(--color-paper, #F8F6F1)",
        color: "var(--color-ink, #0B1220)",
        fontFamily:
          "'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
      }}
    >
      <div
        style={{
          maxWidth: 640,
          width: "100%",
          backgroundColor: "var(--color-surface, #FFFFFF)",
          border: "1px solid var(--color-rule, #E6E1D6)",
          borderLeft: "3px solid var(--color-red, #F43F5E)",
          borderRadius: 12,
          padding: "24px 28px",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--color-muted, #5C6478)",
            marginBottom: 8,
          }}
        >
          Executive Assistant · runtime error
        </div>
        <h1
          style={{
            margin: "0 0 12px",
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: "-0.005em",
          }}
        >
          Something broke while rendering.
        </h1>
        <p
          style={{
            margin: "0 0 16px",
            fontSize: 14,
            lineHeight: 1.55,
            color: "var(--color-muted, #5C6478)",
          }}
        >
          {isDev
            ? "A component threw during render. The page would normally go blank — this card is here so you can read the error."
            : "The dossier surface couldn't render. Try the button below; if it persists, refresh the page."}
        </p>

        {isDev && (
          <pre
            style={{
              backgroundColor: "var(--color-paper-warm, #F1ECE3)",
              border: "1px solid var(--color-rule, #E6E1D6)",
              borderRadius: 6,
              padding: "12px 14px",
              fontSize: 12,
              fontFamily:
                "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
              lineHeight: 1.55,
              color: "var(--color-ink-soft, #2A3447)",
              overflow: "auto",
              maxHeight: 320,
              margin: "0 0 16px",
            }}
          >
            {error.name}: {error.message}
            {error.stack ? `\n\n${error.stack}` : ""}
          </pre>
        )}

        <button
          type="button"
          onClick={onReset}
          style={{
            backgroundColor: "var(--color-accent, #B45309)",
            color: "white",
            border: "1px solid var(--color-accent, #B45309)",
            borderRadius: 6,
            padding: "6px 14px",
            fontSize: 13,
            fontWeight: 500,
            fontFamily: "inherit",
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </div>
    </div>
  );
}
