import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RefreshCw, TriangleAlert } from 'lucide-react';

type Props = {
  children: ReactNode;
  /** What failed, for the message ("This page", "The dialog"). */
  scope?: string;
  /** Offered next to Reload, e.g. going back to the overview. */
  onReset?: () => void;
  resetLabel?: string;
  /** Replaces the default panel, e.g. to keep the message inside a dialog. */
  fallback?: (error: Error) => ReactNode;
};

/**
 * Catches a render error so one broken view (an unexpected RPC value, a stale stored record) shows a message
 * with a way out instead of blanking the whole app. Key it by view so navigating away clears it.
 */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Mezodot view crashed', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error);
    const { scope = 'This page', onReset, resetLabel = 'Go to the overview' } = this.props;
    return (
      <div className="panel empty-state empty-state--panel" role="alert">
        <TriangleAlert size={23} />
        <b>{scope} hit an unexpected error</b>
        <span>{error.message.split('\n')[0]}</span>
        <div className="empty-state-actions">
          <button className="button button--dark" onClick={() => window.location.reload()}>
            <RefreshCw size={14} /> Reload
          </button>
          {onReset && (
            <button
              className="button button--light"
              onClick={() => {
                this.setState({ error: null });
                onReset();
              }}
            >
              {resetLabel}
            </button>
          )}
        </div>
      </div>
    );
  }
}
