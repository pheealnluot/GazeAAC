import { initializeApp, getApps, getApp } from 'firebase/app'
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  GoogleAuthProvider,
  EmailAuthProvider,
  signInWithPopup,
  fetchSignInMethodsForEmail,
  linkWithCredential,
} from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

// GazeAAC Web SDK Configuration
const firebaseConfig = {
  projectId: "gazeaac-app-sync",
  appId: "1:396446082530:web:e4d4ab1b5029695452c5bb",
  storageBucket: "gazeaac-app-sync.firebasestorage.app",
  apiKey: "AIzaSyB0HeiNJNYr6lOMLFm7oAjprmEM-OFm0G8",
  authDomain: "gazeaac-app-sync.firebaseapp.com",
  messagingSenderId: "396446082530"
}

// Initialize Firebase App safely (checks if already initialized for Hot Module Replacement / HMR)
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp()

export const auth = getAuth(app)
export const db   = getFirestore(app)

/**
 * Sign in a caregiver with email and password
 * @param {string} email
 * @param {string} password
 * @returns {Promise<import('firebase/auth').UserCredential>}
 */
export function signInCaregiver(email, password) {
  return signInWithEmailAndPassword(auth, email.trim(), password)
}

/**
 * Register a new caregiver with email and password
 * @param {string} email
 * @param {string} password
 * @returns {Promise<import('firebase/auth').UserCredential>}
 */
export function signUpCaregiver(email, password) {
  return createUserWithEmailAndPassword(auth, email.trim(), password)
}

/**
 * Sign in with Google.
 *
 * Uses Firebase's signInWithPopup(). In Electron, the popup window.open() call
 * is intercepted by setWindowOpenHandler() in main.js, which opens it as a real
 * BrowserWindow with sandbox:false and the same session as the main window.
 * This allows Firebase's window.opener.postMessage() handshake to complete.
 *
 * @returns {Promise<import('firebase/auth').UserCredential>}
 */
export function signInWithGoogle() {
  const provider = new GoogleAuthProvider()
  provider.addScope('email')
  provider.addScope('profile')
  return signInWithPopup(auth, provider)
}

/**
 * Handles the case where a user tries to sign in with email/password but
 * the email is already linked to a Google (or other) provider.
 *
 * Strategy:
 *   1. Re-authenticate the user via Google popup (to prove ownership of the account)
 *   2. Link the email/password credential to the existing account so both
 *      sign-in methods work going forward
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<import('firebase/auth').UserCredential>}
 */
export async function linkEmailPasswordToGoogleAccount(email, password) {
  // Step 1: sign in with Google to get the existing account
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ login_hint: email })
  const googleResult = await signInWithPopup(auth, provider)

  // Step 2: create the email/password credential and link it
  const emailCredential = EmailAuthProvider.credential(email.trim(), password)
  await linkWithCredential(googleResult.user, emailCredential)

  return googleResult
}

/**
 * Check which sign-in methods are registered for an email address.
 * @param {string} email
 * @returns {Promise<string[]>}
 */
export function fetchMethodsForEmail(email) {
  return fetchSignInMethodsForEmail(auth, email.trim())
}


/**
 * Sign out the currently logged-in caregiver
 * @returns {Promise<void>}
 */
export function signOutCaregiver() {
  return signOut(auth)
}

/**
 * Listen for authentication state changes
 * @param {(user: import('firebase/auth').User | null) => void} callback
 * @returns {import('firebase/auth').Unsubscribe}
 */
export function subscribeToAuth(callback) {
  return onAuthStateChanged(auth, callback)
}
