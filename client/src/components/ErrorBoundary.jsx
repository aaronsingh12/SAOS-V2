import { Component } from 'react';
import { toast } from './toast.js';
import { logToServer } from '../logging.js';

/**
 * D-3 — the route-level failure card.
 *
 * Without this, one bad render anywhere in a page unmounts the whole app and
 * leaves a blank screen: no wordmark, no sidebar, nothing to click, and the
 * only evidence in a console the user is not looking at. That is the worst
 * possible failure mode for a tool whose entire pitch is "you can see what
 * happened".
 *
 * The card is deliberately copyable. Every bug report about this app has to
 * travel through a person, so the stack has to be one button away rather than
 * something they are asked to retype from a screenshot.
 *
 * Keyed on the route path by the caller, so navigating away resets it — an
 * error boundary that latches means one bad page bricks the session.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep the console entry: this is a genuine defect, and swallowing it
    // would make the boundary itself a place where evidence goes missing.
    console.error('SAOS render error', error, info);
    // The console patch would catch this too, but the component stack is the
    // useful half and only exists here.
    logToServer('error', `render error on ${this.props.where || 'a page'}: ${error?.message || error}`,
      `${error?.stack || ''}\n\nComponent stack:${info?.componentStack || ''}`);
    this.setState({ info });
  }

  report() {
    const { error, info } = this.state;
    return [
      `SAOS — render error on ${this.props.where || 'a page'}`,
      `${error?.name || 'Error'}: ${error?.message || String(error)}`,
      '',
      (error?.stack || '(no stack)'),
      '',
      'Component stack:',
      (info?.componentStack || '(none)').trim(),
    ].join('\n');
  }

  async copy() {
    const text = this.report();
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Error details copied.');
    } catch {
      // Clipboard access is refused outside a secure context. Say so, and
      // leave the text on screen where it can be selected by hand.
      toast.error('The browser refused clipboard access — select the text below and copy it manually.');
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card error-card" role="alert">
        <div className="card-title" style={{ color: 'var(--red)' }}>This page failed to render</div>
        <p style={{ margin: '0 0 12px', color: 'var(--muted)', fontSize: 13 }}>
          The rest of SAOS is still running — pick another page in the sidebar. Nothing was written to
          your instance by this failure.
        </p>
        <div className="row" style={{ marginBottom: 10 }}>
          <button className="btn danger sm" onClick={() => this.setState({ error: null, info: null })}>
            Try again
          </button>
          <button className="btn sm" onClick={() => this.copy()}>Copy error details</button>
        </div>
        <pre className="error-dump mono">{this.report()}</pre>
      </div>
    );
  }
}
