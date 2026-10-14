ALTER TABLE sessions
  ADD COLUMN last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) AFTER created_at,
  ADD KEY ix_sessions_user_expiry (user_id, expires_at);

UPDATE sessions
SET expires_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 180 DAY)
WHERE expires_at > CURRENT_TIMESTAMP(3);
