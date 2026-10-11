-- Retire installation and repository instruction overrides. Captured turn starts,
-- execution inspections, and session history remain unchanged.
DELETE FROM settings_overrides WHERE key = 'coding.repository_instructions';
