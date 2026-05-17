import { Component } from 'react'

/**
 * ErrorBoundary — catches any React render/lifecycle error inside the app tree
 * and displays a readable error screen instead of a black window.
 *
 * Without this, a JS exception during render causes the Electron BrowserWindow
 * to stay black (or show only the `backgroundColor` set in main.js) with no
 * visible feedback, making debugging extremely difficult.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    this.setState({ info })
    console.error('[ErrorBoundary] Caught unhandled render error:', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children

    const { error, info } = this.state
    const msg   = error?.message ?? String(error)
    const stack = error?.stack   ?? '(no stack)'
    const comp  = info?.componentStack ?? '(no component stack)'

    return (
      <div style={{
        display:         'flex',
        flexDirection:   'column',
        alignItems:      'center',
        justifyContent:  'center',
        width:           '100vw',
        height:          '100vh',
        background:      '#0d0f14',
        color:           '#e0e6f0',
        fontFamily:      'system-ui, sans-serif',
        padding:         '32px',
        boxSizing:       'border-box',
        gap:             '16px',
        overflow:        'auto',
      }}>
        <div style={{ fontSize: '3rem' }}>⚠️</div>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f87171', margin: 0 }}>
          GazeAAC encountered a render error
        </h1>
        <p style={{ fontSize: '0.85rem', color: '#94a3b8', margin: 0 }}>
          A JavaScript error occurred during rendering. Please check the DevTools console for details.
        </p>

        <div style={{
          background:   '#161927',
          border:       '1px solid #334155',
          borderRadius: '8px',
          padding:      '16px',
          width:        '100%',
          maxWidth:     '860px',
          textAlign:    'left',
          overflow:     'auto',
        }}>
          <p style={{ color: '#f87171', fontWeight: 600, marginBottom: '8px', fontSize: '0.9rem' }}>
            {msg}
          </p>
          <pre style={{ fontSize: '0.72rem', color: '#64748b', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
            {stack}
          </pre>
          {comp && (
            <>
              <hr style={{ border: 'none', borderTop: '1px solid #334155', margin: '12px 0' }} />
              <p style={{ color: '#94a3b8', fontSize: '0.72rem', fontWeight: 600, marginBottom: '4px' }}>
                Component stack:
              </p>
              <pre style={{ fontSize: '0.68rem', color: '#475569', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
                {comp}
              </pre>
            </>
          )}
        </div>

        <button
          onClick={() => this.setState({ error: null, info: null })}
          style={{
            marginTop:    '8px',
            padding:      '8px 24px',
            background:   'hsl(195,100%,55%)',
            border:       'none',
            borderRadius: '6px',
            color:        '#000',
            fontWeight:   700,
            fontSize:     '0.85rem',
            cursor:       'pointer',
          }}
        >
          Retry
        </button>
      </div>
    )
  }
}
