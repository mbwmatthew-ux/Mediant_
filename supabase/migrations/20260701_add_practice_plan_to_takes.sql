-- AI-generated daily practice plan, created after every completed analysis.
-- Stores a 5-day structured plan the Calendar page reads to show upcoming tasks.
ALTER TABLE takes ADD COLUMN IF NOT EXISTS practice_plan JSONB;
