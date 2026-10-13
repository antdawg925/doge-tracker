import { Component } from 'react';

/** Catches render crashes so a broken panel shows a small message instead of a blank page. */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error(`[${this.props.name || 'panel'}] crashed:`, error, info?.componentStack);
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="card err-boundary" role="alert">
        <p className="neg small">
          <strong>{this.props.name || 'This part'} hit an error</strong> — {String(error?.message || error)}
        </p>
        <button type="button" className="btn btn--ghost stk-btn" onClick={() => { this.setState({ error: null }); this.props.onReset?.(); }}>
          {this.props.onReset ? 'Close' : 'Try again'}
        </button>
      </div>
    );
  }
}
