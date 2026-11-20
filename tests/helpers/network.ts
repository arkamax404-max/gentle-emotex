/**
 * Test-owned network isolation for integration boots.
 *
 * `boot()` installs this guard so extension code can never reach the real
 * network from a test run, even when a test provides no fetch mock of its own
 * (the shipped config enables a loopback receiver, so an unguarded boot would
 * contact it). A boot that starts with the pristine fetch records every
 * request and answers it locally; a boot whose fetch was already replaced by
 * the test keeps that mock untouched, so tests that intentionally record
 * calls keep working. Restoring only uninstalls the guard that is actually
 * installed, never a test's own mock.
 */

export interface GuardedRequest { url: string; init?: RequestInit }

/** The untouched fetch, captured when this helper first loads, before any test runs. */
const PRISTINE_FETCH = globalThis.fetch as GuardedFetch;

export interface NetworkGuard {
  /** Every request the guard captured, in order. */
  requests: GuardedRequest[];
  /** Uninstalls the guard only when it is the currently installed fetch. */
  restore(): void;
}

interface GuardedFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  __emoteNetworkGuard?: NetworkGuard;
}

export function installNetworkGuard(): NetworkGuard {
  const previous = globalThis.fetch as GuardedFetch;
  // A test-owned mock (anything other than the pristine fetch captured at module
  // load, before any test runs) keeps owning the network: the boot stays passive
  // so intentional recording mocks keep receiving every call.
  if (previous !== PRISTINE_FETCH) return { requests: [], restore() { } };
  const requests: GuardedRequest[] = [];
  const guard = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push({ url: typeof input === "string" ? input : String((input as RequestInfo & { url?: string }).url ?? input), init });
    return Promise.resolve(new Response());
  }) as GuardedFetch;
  const owned: NetworkGuard = {
    requests,
    restore() { if ((globalThis.fetch as GuardedFetch) === guard) globalThis.fetch = previous; },
  };
  guard.__emoteNetworkGuard = owned;
  globalThis.fetch = guard;
  return owned;
}
