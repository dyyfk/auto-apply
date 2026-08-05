// Central API helper — injects the auth token on every request.
export function getToken() {
  return localStorage.getItem('auth_token') || '';
}
export function setToken(token) {
  localStorage.setItem('auth_token', token);
}
export function clearToken() {
  localStorage.removeItem('auth_token');
}

export async function apiFetch(url, options = {}) {
  const token = getToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    clearToken();
    window.location.href = '/login';
    throw new Error('Session expired. Please log in again.');
  }
  return res;
}
