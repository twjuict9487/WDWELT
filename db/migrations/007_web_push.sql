CREATE TABLE IF NOT EXISTS push_subscriptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  endpoint_hash BINARY(32) NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh VARCHAR(255) NOT NULL,
  auth_secret VARCHAR(255) NOT NULL,
  expiration_time BIGINT NULL,
  reminder_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 10,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  failure_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_push_endpoint_hash (endpoint_hash),
  KEY ix_push_user_enabled (user_id, enabled),
  CONSTRAINT chk_push_reminder CHECK (reminder_minutes BETWEEN 0 AND 120),
  CONSTRAINT fk_push_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS push_deliveries (
  subscription_id BIGINT UNSIGNED NOT NULL,
  timetable_user_id INT NOT NULL,
  weekday TINYINT UNSIGNED NOT NULL,
  period TINYINT UNSIGNED NOT NULL,
  class_date DATE NOT NULL,
  sent_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (subscription_id, timetable_user_id, weekday, period, class_date),
  CONSTRAINT fk_delivery_subscription FOREIGN KEY (subscription_id) REFERENCES push_subscriptions (id) ON DELETE CASCADE,
  CONSTRAINT fk_delivery_entry FOREIGN KEY (timetable_user_id, weekday, period) REFERENCES timetable_entries (user_id, weekday, period) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
