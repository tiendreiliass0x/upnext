/**
 * Parse a JSON response body, turning a non-JSON body (an HTML error page from
 * a proxy, a route that is not ready yet) into a readable error instead of a
 * bare `JSON.parse` exception. The body has its own deadline because fetch
 * resolves when the headers arrive, before a stalled response is complete.
 */
export async function readJson<T>(
  response: Response,
  timeoutMs = 8000,
): Promise<T> {
  const reader = response.body?.getReader();
  let text = "";
  if (reader) {
    const decoder = new TextDecoder();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void reader.cancel();
    }, timeoutMs);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (timedOut) throw new Error("The connection timed out.");
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `The server sent an unexpected response (${response.status}).`,
    );
  }
}

/**
 * `fetch` with a deadline. The browser's own fetch has no timeout, so a
 * connection that stalls rather than resets never settles and whatever is
 * awaiting it waits for good. Every call that can be left hanging by bad
 * wifi — or by a dev tunnel dropping a large upload — goes through here.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = 8000,
) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (requestError) {
    if (timedOut) throw new Error("The connection timed out.");
    throw requestError;
  } finally {
    clearTimeout(timer);
  }
}
