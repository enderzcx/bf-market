// JSON fetch helpers for the public console. Kept in one module so the React
// page and the framework-free console state share the same request handling.

export async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function fetchJson(path, init, fetchImpl = fetch) {
  const response = await fetchImpl(path, init);
  const data = await readJson(response);
  if (!response.ok) {
    const message = typeof data?.error === 'string' && data.error ? data.error : '';
    throw new Error(message || `Request failed (${response.status}).`);
  }
  return data;
}

export function postJson(path, body, fetchImpl = fetch) {
  return fetchJson(
    path,
    {
      method: 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    fetchImpl,
  );
}
