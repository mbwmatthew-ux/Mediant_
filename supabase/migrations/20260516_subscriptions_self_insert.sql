-- Temporary: allow authenticated users to upsert their own subscription row
-- Remove this policy once Stripe webhooks are handling writes
CREATE POLICY "Users can upsert own subscription"
  ON subscriptions FOR ALL
  TO authenticated
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
