/**
 * Accounts: email + password and Google sign-in, backed by the Map Runner API.
 *
 * Without an API (VITE_API_BASE_URL empty) everyone is the local guest and data stays
 * in this browser. Sessions are HttpOnly cookies set by the server; nothing
 * authentication-related is stored by this code.
 *
 * @typedef {{
 *   id: string, name: string, email?: string, avatarUrl?: string | null,
 *   hasPassword?: boolean, googleLinked?: boolean, isAdmin?: boolean, isGuest: boolean,
 * }} User
 */
import { config } from '../../config/env';
import { apiRequest } from '../api/apiClient';

/** @type {User} */
export const GUEST_USER = Object.freeze({ id: 'guest', name: 'Guest', isGuest: true });

export const areAccountsAvailable = () => config.features.accounts;
export const isGoogleSignInAvailable = () => config.features.googleSignIn;

const toUser = (user) => ({ ...user, id: String(user.id), isGuest: false });

/** @returns {Promise<User>} */
export const getCurrentUser = async ({ signal } = {}) => {
  if (!areAccountsAvailable()) return GUEST_USER;
  try {
    const { user } = await apiRequest('/auth/me', { signal, authenticated: false });
    return toUser(user);
  } catch (error) {
    if (error?.status === 401) return GUEST_USER;
    throw error;
  }
};

/** @returns {Promise<{ user: User, notice: string | null }>} */
export const register = async ({ email, password, name }) => {
  const { user } = await apiRequest('/auth/register', { method: 'POST', body: { email, password, name }, authenticated: false });
  return { user: toUser(user), notice: null };
};

/** @returns {Promise<{ user: User, notice: string | null }>} */
export const logIn = async ({ email, password }) => {
  const { user } = await apiRequest('/auth/login', { method: 'POST', body: { email, password }, authenticated: false });
  return { user: toUser(user), notice: null };
};

/**
 * @param {string} credential  Google ID token from Google Identity Services; verified by the server.
 * @returns {Promise<{ user: User, notice: string | null }>}
 */
export const logInWithGoogle = async (credential) => {
  const { user, notice } = await apiRequest('/auth/google', { method: 'POST', body: { credential }, authenticated: false });
  return { user: toUser(user), notice: notice ?? null };
};

export const logOut = async () => {
  await apiRequest('/auth/logout', { method: 'POST', authenticated: false });
  return GUEST_USER;
};
