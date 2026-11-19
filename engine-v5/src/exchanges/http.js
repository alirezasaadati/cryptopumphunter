export async function getJson(url, fetchImpl = fetch, options = {}) {
  const headers = { accept: "application/json", "user-agent": "CryptoPumpHunter-EngineV5/0.1", ...(options.headers || {}) };
  const response = await fetchImpl(url, { method: "GET", headers });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} from ${new URL(url).host}`);
    error.status = response.status;
    error.retryAfter = response.headers?.get?.("retry-after") || null;
    throw error;
  }
  const body = await response.json();
  if (body && Array.isArray(body.error) && body.error.length) {
    throw new Error(`Exchange API error: ${body.error.join(", ")}`);
  }
  return body;
}

export function withQuery(base, params = {}) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const valueAsNumber = Number(value);
  return Number.isFinite(valueAsNumber) ? valueAsNumber : null;
}
