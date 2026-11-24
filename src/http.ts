export type FetchFn = (url: string | URL, init?: RequestInit) => Promise<Response>

export type Clock = {
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

const REQUEST_TIMEOUT_MS = 30_000
const MAX_429_RETRIES = 5
const MAX_RETRY_WAIT_MS = 60_000

// Sends one request. On 429 it waits for Retry-After (or a backoff) and tries again, a few times.
// Error handling stays with the caller: this never reads or logs a response body.
export async function send(
  fetchFn: FetchFn,
  clock: Clock,
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (res.status !== 429 || attempt >= MAX_429_RETRIES) return res
    const retryAfter = Number(res.headers.get('retry-after'))
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt
    await clock.sleep(Math.min(wait, MAX_RETRY_WAIT_MS))
  }
}
