const backendUrl = (import.meta.env.VITE_BACKEND_URL as string) ?? '';

export const API_BASE = backendUrl;

export function getWsUrl(): string {
  if (backendUrl) {
    return backendUrl.replace(/^http/, 'ws') + '/ws';
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}
