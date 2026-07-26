-- AI-generated session summary (headline/overview/strengths/improvements), cached
-- after the first generation so re-opening a take's Analysis page doesn't trigger a
-- fresh Claude API call every time (it was previously regenerated on every page load
-- with identical inputs — pure wasted spend, same content each time).
ALTER TABLE takes ADD COLUMN IF NOT EXISTS ai_summary JSONB;
