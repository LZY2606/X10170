export interface ApiEnvelope { state?: any; events?: any[]; error?: string; references?: any[]; conflictId?: string }

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || '请求失败'), data);
  return data;
}

export const actor = 'editor';
