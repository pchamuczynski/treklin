/**
 * Admin panel. The server decides who is an admin; this module only calls /api/admin.
 */
import { apiRequest } from '../api/apiClient';

const usersPath = (query) => `/admin/users?${new URLSearchParams(query)}`;

/** @returns {Promise<{ users: object[], total: number }>} */
export const listUsers = ({ q = '', offset = 0, limit = 50, signal } = {}) =>
  apiRequest(usersPath({ q, offset: String(offset), limit: String(limit) }), { signal });

/** @returns {Promise<{ user: object, connections: string[], routes: { version: number, routes: object[] } }>} */
export const getUser = (id, { signal } = {}) => apiRequest(`/admin/users/${encodeURIComponent(id)}`, { signal });

/** @returns {Promise<{ user: object }>} */
export const updateUser = (id, body) => apiRequest(`/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body });

/**
 * @returns {Promise<{ version: number, routes: object[], dropped: number }>}
 */
export const saveRoutes = (id, body) => apiRequest(`/admin/users/${encodeURIComponent(id)}/routes`, { method: 'PUT', body });

export const revokeSessions = (id) => apiRequest(`/admin/users/${encodeURIComponent(id)}/sessions/revoke`, { method: 'POST' });
