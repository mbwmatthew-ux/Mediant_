// Run: deno test supabase/functions/analyze-performance/worker-routing.test.ts
// Zero network, zero cost — pure unit tests of the routing decision.

import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { resolveWorkerUrl, type WorkerEnv } from './worker-routing.ts'

function fakeEnv(vars: Record<string, string>): WorkerEnv {
  return { get: (key: string) => vars[key] }
}

const PROD_URL = 'https://prod-worker.modal.run'
const CANARY_URL = 'https://canary-worker.modal.run'
const OWNER_ID = 'owner-user-id-123'
const OTHER_ID = 'some-other-user-456'

Deno.test('owner routes to canary when fully configured', () => {
  const env = fakeEnv({
    MODAL_WORKER_URL: PROD_URL,
    MEDIANT_CANARY_OWNER_USER_ID: OWNER_ID,
    MEDIANT_CANARY_MODAL_WORKER_URL: CANARY_URL,
  })
  const route = resolveWorkerUrl(OWNER_ID, env)
  assertEquals(route.url, CANARY_URL)
  assertEquals(route.routedToCanary, true)
})

Deno.test('other users route to existing production worker', () => {
  const env = fakeEnv({
    MODAL_WORKER_URL: PROD_URL,
    MEDIANT_CANARY_OWNER_USER_ID: OWNER_ID,
    MEDIANT_CANARY_MODAL_WORKER_URL: CANARY_URL,
  })
  const route = resolveWorkerUrl(OTHER_ID, env)
  assertEquals(route.url, PROD_URL)
  assertEquals(route.routedToCanary, false)
})

Deno.test('missing canary owner id falls back to production, even for the would-be owner', () => {
  const env = fakeEnv({
    MODAL_WORKER_URL: PROD_URL,
    MEDIANT_CANARY_MODAL_WORKER_URL: CANARY_URL,
  })
  const route = resolveWorkerUrl(OWNER_ID, env)
  assertEquals(route.url, PROD_URL)
  assertEquals(route.routedToCanary, false)
})

Deno.test('missing canary worker url falls back to production, even for the owner', () => {
  const env = fakeEnv({
    MODAL_WORKER_URL: PROD_URL,
    MEDIANT_CANARY_OWNER_USER_ID: OWNER_ID,
  })
  const route = resolveWorkerUrl(OWNER_ID, env)
  assertEquals(route.url, PROD_URL)
  assertEquals(route.routedToCanary, false)
})

Deno.test('no canary configuration at all preserves today\'s behavior exactly', () => {
  const env = fakeEnv({ MODAL_WORKER_URL: PROD_URL })
  assertEquals(resolveWorkerUrl(OWNER_ID, env).url, PROD_URL)
  assertEquals(resolveWorkerUrl(OTHER_ID, env).url, PROD_URL)
})

Deno.test('a client-suppliable-looking id cannot self-route without server config', () => {
  // No MEDIANT_CANARY_* set — simulates an attacker guessing/sending an id
  // that happens to equal a real owner id with no canary secrets configured.
  const env = fakeEnv({ MODAL_WORKER_URL: PROD_URL })
  const route = resolveWorkerUrl(OWNER_ID, env)
  assertEquals(route.routedToCanary, false)
})
