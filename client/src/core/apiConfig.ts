const rawBase = (import.meta as any).env?.VITE_API_URL as string | undefined;
const rawLiveToken = (import.meta as any).env?.VITE_KINETIX_LIVE_TOKEN as string | undefined;

export const API_BASE_URL = (rawBase && rawBase.trim() ? rawBase.trim() : '').replace(
  /\/+$/,
  ''
);

export const apiUrl = (path: string): string =>
  `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;

export const apiHeaders = (extra: Record<string, string> = {}): Record<string, string> => {
  const headers: Record<string, string> = { ...extra };
  if (rawLiveToken && rawLiveToken.trim()) {
    headers['X-Kinetix-Live-Token'] = rawLiveToken.trim();
  }
  return headers;
};
