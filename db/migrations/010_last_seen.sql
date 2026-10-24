ALTER TABLE users
  ADD COLUMN last_seen_at DATETIME(3) NULL AFTER created_at,
  ADD KEY ix_users_last_seen (last_seen_at);
