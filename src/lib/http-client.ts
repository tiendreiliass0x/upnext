/**
 * Parse a JSON response body, turning a non-JSON body (an HTML error page from
 * a proxy, a route that is not ready yet) into a readable error instead of a
 * bare `JSON.parse` exception.
 */
export async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `The server sent an unexpected response (${response.status}).`,
    );
  }
}
