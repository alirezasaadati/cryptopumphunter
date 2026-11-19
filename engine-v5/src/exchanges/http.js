export async function getJson(url, fetchImpl = fetch, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("exchange request timeout"), timeoutMs);
  const headers = { accept: "application/json", "user-agent": "CryptoPumpHunter-EngineV5/0.1", ...(options.headers || {}) };

  try {
    const response = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} from ${new URL(url).host}`);
      error.status = response.status;
      error.code = response.status === 429 ? "RATE_LIMITED" : response.status >= 500 ? "UPSTREAM_ERROR" : "HTTP_ERROR";
      error.retryAfter = response.headers?.get?.("retry-after") || null;
      throw error;
    }
    const body = await response.json();
    if (body && Array.isArray(body.error) && body.error.length) {
      throw new Error(`Exchange API error: ${body.error.join(", ")}`);
    }
    return body;
  } catch (error) {
    if (controller.signal.aborted && error?.name !== "AbortError") {
      const timeoutError = new Error(`Exchange request timed out after ${timeoutMs}ms`);
      timeoutError.code = "REQUEST_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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
