import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@13'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
})

async function upsertSubscription(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  customerId: string,
  sub: Stripe.Subscription
) {
  const interval = sub.items.data[0].price.recurring?.interval
  await supabase.from('subscriptions').upsert({
    user_id:                userId,
    stripe_customer_id:     customerId,
    stripe_subscription_id: sub.id,
    status:                 sub.status,
    plan:                   interval === 'year' ? 'yearly' : 'monthly',
    current_period_end:     new Date(sub.current_period_end * 1000).toISOString(),
    updated_at:             new Date().toISOString(),
  }, { onConflict: 'user_id' })
}

serve(async (req) => {
  const sig  = req.headers.get('stripe-signature')!
  const body = await req.text()

  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(
      body, sig, Deno.env.get('STRIPE_WEBHOOK_SECRET')!
    )
  } catch (err) {
    return new Response(`Webhook error: ${(err as Error).message}`, { status: 400 })
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  if (event.type === 'checkout.session.completed') {
    const session    = event.data.object as Stripe.Checkout.Session
    const customerId = session.customer as string
    const customer   = await stripe.customers.retrieve(customerId) as Stripe.Customer
    const userId     = customer.metadata.supabase_user_id
    const sub        = await stripe.subscriptions.retrieve(session.subscription as string)
    await upsertSubscription(admin, userId, customerId, sub)
  }

  if (
    event.type === 'customer.subscription.updated' ||
    event.type === 'customer.subscription.deleted'
  ) {
    const sub        = event.data.object as Stripe.Subscription
    const customerId = sub.customer as string
    const customer   = await stripe.customers.retrieve(customerId) as Stripe.Customer
    const userId     = customer.metadata.supabase_user_id
    await upsertSubscription(admin, userId, customerId, sub)
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
