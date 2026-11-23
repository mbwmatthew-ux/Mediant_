// Owner-only canary routing for the Modal analysis dispatch.
//
// Server-side only: userId must come from an already-verified
// supabase.auth.getUser() result (see index.ts), never from the request
// body — a client-supplied id would let any caller route themselves to
// the canary worker.
//
// Missing/partial canary configuration always falls through to the
// existing production URL, so an unset secret can never change behavior
// for anyone, owner included.

export type WorkerEnv = { get(key: string): string | undefined }

export type WorkerRoute = {
  url: string | null
  routedToCanary: boolean
}

export function resolveWorkerUrl(userId: string, env: WorkerEnv): WorkerRoute {
  const prodUrl = env.get('MODAL_WORKER_URL') ?? null
  const ownerUserId = env.get('MEDIANT_CANARY_OWNER_USER_ID')
  const canaryUrl = env.get('MEDIANT_CANARY_MODAL_WORKER_URL')

  if (ownerUserId && canaryUrl && userId === ownerUserId) {
    return { url: canaryUrl, routedToCanary: true }
  }
  return { url: prodUrl, routedToCanary: false }
}
