import type { FetchLike } from "../core/http.js";

/** A request captured by {@link mockFetch}. Header names are lowercase. */
export type RecordedRequest = {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal | undefined;
};

/** A canned response. Object bodies are sent as JSON. */
export type MockResponse = {
  readonly status: number;
  readonly body?: string | object;
  readonly headers?: Readonly<Record<string, string>>;
};

/** What a {@link mockFetch} responder returns: a response, or an error to throw (network failure). */
export type MockReply = MockResponse | { readonly throws: unknown } | { readonly hangUntilAborted: true };

/** A recording fake `fetch`. */
export type MockFetch = {
  readonly fetch: FetchLike;
  readonly calls: readonly RecordedRequest[];
};

/**
 * Creates a fake `fetch` that records every request and answers with
 * `responder`. `{ throws }` simulates a network error; `{ hangUntilAborted }`
 * waits until the request signal aborts, to test timeouts.
 */
export function mockFetch(responder: MockReply | ((request: RecordedRequest) => MockReply)): MockFetch {
  const calls: RecordedRequest[] = [];

  const fetcher: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const recorded: RecordedRequest = {
      url: input,
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? init.body : "",
      signal: init.signal ?? undefined,
    };
    calls.push(recorded);

    const reply = typeof responder === "function" ? responder(recorded) : responder;
    if ("throws" in reply) {
      throw reply.throws;
    }
    if ("hangUntilAborted" in reply) {
      return new Promise<Response>((_, reject) => {
        const signal = init.signal;
        if (signal === undefined || signal === null) {
          return;
        }
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    const body = reply.body === undefined ? "" : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(body, {
      status: reply.status,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  };

  return { fetch: fetcher, calls };
}
