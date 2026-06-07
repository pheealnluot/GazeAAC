import { useState, useEffect } from 'react'
import {
  signInCaregiver,
  signUpCaregiver,
  signInWithGoogle,
  subscribeToAuth,
  linkEmailPasswordToGoogleAccount,
} from '../engine/firebase'
import './AuthScreen.css'

/**
 * AuthScreen
 *
 * Full-screen login/signup screen shown before calibration.
 * Supports:
 *   - Email + Password (sign in / sign up)
 *   - Google Sign-In (OAuth popup)
 *   - Guest mode (skip auth, local-only settings)
 *
 * Props:
 *   onAuthenticated  {() => void}  – Called when Firebase auth succeeds (email or Google)
 *   onGuest          {() => void}  – Called when user chooses Guest mode
 */
export function AuthScreen({ onAuthenticated, onGuest }) {
  // ── Auth state ─────────────────────────────────────────────────────────────
  const [checking, setChecking]     = useState(true)   // true while Firebase resolves session
  const [existingUser, setExistingUser] = useState(null) // non-null = active session found
  const [showFresh, setShowFresh]   = useState(false)  // override: show login form even if session exists

  // ── Form state ─────────────────────────────────────────────────────────────
  const [tab, setTab]               = useState('signin') // 'signin' | 'signup'
  const [email, setEmail]           = useState('')
  const [password, setPassword]     = useState('')
  const [confirmPw, setConfirmPw]   = useState('')
  const [busy, setBusy]             = useState(false)
  const [errorMsg, setErrorMsg]     = useState(null)
  const [successMsg, setSuccessMsg] = useState(null)
  // When the email belongs to a Google account, we offer to link email/password to it
  const [linkPending, setLinkPending] = useState(null) // { email, password } | null

  // ── On mount: check if Firebase already has a session ──────────────────────
  useEffect(() => {
    const unsub = subscribeToAuth((user) => {
      setChecking(false)
      if (user) {
        setExistingUser(user)
      }
      // Unsubscribe after the first emission — we only need the initial check
      unsub()
    })
    return unsub
  }, [])

  // ── Helpers ────────────────────────────────────────────────────────────────
  const clearMessages = () => { setErrorMsg(null); setSuccessMsg(null) }

  const handleEmailAuth = async (e) => {
    e.preventDefault()
    clearMessages()

    if (!email.trim() || !password) {
      setErrorMsg('Please enter your email and password.')
      return
    }
    if (tab === 'signup' && password !== confirmPw) {
      setErrorMsg('Passwords do not match.')
      return
    }
    if (tab === 'signup' && password.length < 6) {
      setErrorMsg('Password must be at least 6 characters.')
      return
    }

    setBusy(true)
    try {
      if (tab === 'signup') {
        await signUpCaregiver(email, password)
        setSuccessMsg('Account created! Signing you in…')
      } else {
        await signInCaregiver(email, password)
      }
      onAuthenticated()
    } catch (err) {
      // email-already-in-use during SIGNUP = Google-only account exists → offer to link
      // account-exists-with-different-credential during SIGNIN = same situation
      const isGoogleCollision =
        err.code === 'auth/email-already-in-use' ||
        err.code === 'auth/account-exists-with-different-credential'

      if (isGoogleCollision) {
        setLinkPending({ email: email.trim(), password })
        setErrorMsg(null)
      } else if (
        err.code === 'auth/wrong-password' ||
        err.code === 'auth/invalid-credential'
      ) {
        setErrorMsg(friendlyFirebaseError(err.code))
      } else {
        const msg = friendlyFirebaseError(err.code)
        setErrorMsg(msg)
      }
    } finally {
      setBusy(false)
    }
  }

  const handleGoogle = async () => {
    clearMessages()
    setBusy(true)
    try {
      await signInWithGoogle()
      onAuthenticated()
    } catch (err) {
      // 'cancelled' = user closed the Google sign-in popup window
      const isCancelled =
        err.message === 'cancelled' ||
        err.code === 'auth/popup-closed-by-user' ||
        err.code === 'auth/cancelled-popup-request'

      if (!isCancelled) {
        console.error('[AuthScreen] Google sign-in error:', err.code, err.message)
        const friendly = friendlyFirebaseError(err.code)
        setErrorMsg(
          friendly !== 'Authentication failed. Please try again.'
            ? friendly
            : `Google sign-in failed (${err.code || err.message}). Try email instead.`
        )
      }
    } finally {
      setBusy(false)
    }
  }

  /** Link email/password to the existing Google account */
  const handleLinkAccount = async () => {
    if (!linkPending) return
    clearMessages()
    setBusy(true)
    try {
      await linkEmailPasswordToGoogleAccount(linkPending.email, linkPending.password)
      setLinkPending(null)
      setSuccessMsg('Accounts linked! You can now sign in with either Google or email/password.')
      onAuthenticated()
    } catch (err) {
      const isCancelled =
        err.message === 'cancelled' ||
        err.code === 'auth/popup-closed-by-user' ||
        err.code === 'auth/cancelled-popup-request'
      if (isCancelled) {
        setLinkPending(null)
        setErrorMsg('Linking cancelled. Try signing in with Google instead.')
      } else {
        setErrorMsg(`Could not link accounts: ${friendlyFirebaseError(err.code)}`)
      }
    } finally {
      setBusy(false)
    }
  }

  const handleTabChange = (t) => {
    setTab(t)
    clearMessages()
    setConfirmPw('')
  }

  // ── Render: checking Firebase session ──────────────────────────────────────
  if (checking) {
    return (
      <div className="auth-screen">
        <div className="auth-screen__bg" />
        <div className="auth-screen__orb auth-screen__orb--1" />
        <div className="auth-screen__orb auth-screen__orb--2" />
        <div className="auth-screen__orb auth-screen__orb--3" />
        <div className="auth-card">
          <div className="auth-checking">
            <div className="auth-checking__spinner" />
            <span>Checking your session…</span>
          </div>
        </div>
      </div>
    )
  }

  // ── Render: existing session found ─────────────────────────────────────────
  if (existingUser && !showFresh) {
    const displayName = existingUser.displayName || existingUser.email?.split('@')[0] || 'Caregiver'
    const avatarChar  = (existingUser.displayName?.[0] || existingUser.email?.[0] || '?').toUpperCase()

    return (
      <div className="auth-screen">
        <div className="auth-screen__bg" />
        <div className="auth-screen__orb auth-screen__orb--1" />
        <div className="auth-screen__orb auth-screen__orb--2" />
        <div className="auth-screen__orb auth-screen__orb--3" />
        <div className="auth-card">
          <div className="auth-card__logo">
            <span className="auth-card__logo-icon">👁</span>
            <span className="auth-card__app-name">GazeAAC</span>
            <span className="auth-card__tagline">Eye-Gaze Communication</span>
          </div>

          <div className="auth-session-banner">
            <div className="auth-session-banner__avatar">{avatarChar}</div>
            <span className="auth-session-banner__name">Welcome back, {displayName}!</span>
            <span className="auth-session-banner__email">{existingUser.email}</span>
            <div className="auth-session-banner__badge">
              <span className="auth-session-banner__dot" />
              Cloud Sync Active
            </div>

            <button
              id="auth-btn-continue"
              className="auth-session-banner__continue-btn"
              onClick={onAuthenticated}
            >
              Continue →
            </button>

            <button
              className="auth-session-banner__switch-btn"
              onClick={() => setShowFresh(true)}
            >
              Switch account or continue as guest
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Render: account-linking prompt ─────────────────────────────────────────
  if (linkPending) {
    return (
      <div className="auth-screen">
        <div className="auth-screen__bg" />
        <div className="auth-screen__orb auth-screen__orb--1" />
        <div className="auth-screen__orb auth-screen__orb--2" />
        <div className="auth-screen__orb auth-screen__orb--3" />
        <div className="auth-card">
          <div className="auth-card__logo">
            <span className="auth-card__logo-icon">👁</span>
            <span className="auth-card__app-name">GazeAAC</span>
          </div>

          <div className="auth-link-prompt">
            <div className="auth-link-prompt__icon">🔗</div>
            <h2 className="auth-link-prompt__title">Connect your accounts</h2>
            <p className="auth-link-prompt__body">
              <strong>{linkPending.email}</strong> is already registered via{' '}
              <strong>Google Sign-In</strong>. Would you like to also enable
              email &amp; password sign-in for this account?
            </p>
            <p className="auth-link-prompt__sub">
              You'll be asked to confirm with Google once, then both methods
              will work forever.
            </p>

            {errorMsg && (
              <div className="auth-alert auth-alert--error" role="alert">
                ⚠ {errorMsg}
              </div>
            )}

            <button
              id="auth-btn-link-confirm"
              className="auth-btn-primary"
              onClick={handleLinkAccount}
              disabled={busy}
            >
              {busy
                ? <><span className="auth-spinner" /> Linking accounts…</>
                : '🔗 Yes, link my accounts'}
            </button>

            <button
              id="auth-btn-link-cancel"
              className="auth-btn-guest"
              onClick={() => { setLinkPending(null); clearMessages() }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Render: login / signup form ────────────────────────────────────────────
  return (
    <div className="auth-screen">
      <div className="auth-screen__bg" />
      <div className="auth-screen__orb auth-screen__orb--1" />
      <div className="auth-screen__orb auth-screen__orb--2" />
      <div className="auth-screen__orb auth-screen__orb--3" />

      <div className="auth-card">
        {/* Logo */}
        <div className="auth-card__logo">
          <span className="auth-card__logo-icon">👁</span>
          <span className="auth-card__app-name">GazeAAC</span>
          <span className="auth-card__tagline">Eye-Gaze Communication Platform</span>
        </div>

        {/* Tab switcher */}
        <div className="auth-tabs" role="tablist">
          <button
            id="auth-tab-signin"
            role="tab"
            aria-selected={tab === 'signin'}
            className={`auth-tab ${tab === 'signin' ? 'auth-tab--active' : ''}`}
            onClick={() => handleTabChange('signin')}
          >
            Sign In
          </button>
          <button
            id="auth-tab-signup"
            role="tab"
            aria-selected={tab === 'signup'}
            className={`auth-tab ${tab === 'signup' ? 'auth-tab--active' : ''}`}
            onClick={() => handleTabChange('signup')}
          >
            Create Account
          </button>
        </div>

        {/* Email / password form */}
        <form className="auth-form" onSubmit={handleEmailAuth} noValidate>
          <div className="auth-field">
            <label className="auth-field__label" htmlFor="auth-input-email">Email Address</label>
            <input
              id="auth-input-email"
              type="email"
              className="auth-field__input"
              placeholder="caregiver@example.com"
              value={email}
              onChange={e => { setEmail(e.target.value); clearMessages() }}
              autoComplete="email"
              disabled={busy}
            />
          </div>

          <div className="auth-field">
            <label className="auth-field__label" htmlFor="auth-input-password">Password</label>
            <input
              id="auth-input-password"
              type="password"
              className="auth-field__input"
              placeholder="••••••••"
              value={password}
              onChange={e => { setPassword(e.target.value); clearMessages() }}
              autoComplete={tab === 'signup' ? 'new-password' : 'current-password'}
              disabled={busy}
            />
          </div>

          {tab === 'signup' && (
            <div className="auth-field">
              <label className="auth-field__label" htmlFor="auth-input-confirm">Confirm Password</label>
              <input
                id="auth-input-confirm"
                type="password"
                className="auth-field__input"
                placeholder="••••••••"
                value={confirmPw}
                onChange={e => { setConfirmPw(e.target.value); clearMessages() }}
                autoComplete="new-password"
                disabled={busy}
              />
            </div>
          )}

          {errorMsg && (
            <div className="auth-alert auth-alert--error" role="alert">
              ⚠ {errorMsg}
            </div>
          )}
          {successMsg && (
            <div className="auth-alert auth-alert--success" role="status">
              ✓ {successMsg}
            </div>
          )}

          <button
            id="auth-btn-email-submit"
            type="submit"
            className="auth-btn-primary"
            disabled={busy}
          >
            {busy
              ? <><span className="auth-spinner" />{tab === 'signup' ? 'Creating account…' : 'Signing in…'}</>
              : tab === 'signup' ? 'Create Account' : 'Sign In'
            }
          </button>
        </form>

        {/* Divider */}
        <div className="auth-divider">or</div>

        {/* Google */}
        <button
          id="auth-btn-google"
          type="button"
          className="auth-btn-google"
          onClick={handleGoogle}
          disabled={busy}
        >
          {/* Inline Google "G" SVG — no external dependency */}
          <svg className="auth-btn-google__icon" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
            <path fill="none" d="M0 0h48v48H0z"/>
          </svg>
          Continue with Google
        </button>

        {/* Guest mode */}
        <button
          id="auth-btn-guest"
          type="button"
          className="auth-btn-guest"
          onClick={onGuest}
          disabled={busy}
        >
          👤 Continue as Guest
        </button>

        <p className="auth-footer-note">
          Sign in to sync your settings, Gemini API key, and session history across devices.<br />
          Guest mode uses local storage only — no account required.
        </p>
      </div>
    </div>
  )
}

// ── Friendly Firebase error messages ──────────────────────────────────────────

function friendlyFirebaseError(code) {
  switch (code) {
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'Incorrect email or password. Please try again.'
    case 'auth/account-exists-with-different-credential':
      return 'This email is already registered with a different sign-in method (e.g. Google).'
    case 'auth/email-already-in-use':
      return 'This email is already registered. Try signing in instead.'
    case 'auth/invalid-email':
      return 'Please enter a valid email address.'
    case 'auth/weak-password':
      return 'Password must be at least 6 characters.'
    case 'auth/too-many-requests':
      return 'Too many failed attempts. Please wait a moment and try again.'
    case 'auth/network-request-failed':
      return 'Network error. Check your connection and try again.'
    case 'auth/popup-blocked':
      return 'Popup was blocked. Please allow popups for this app and try again.'
    default:
      return 'Authentication failed. Please try again.'
  }
}
