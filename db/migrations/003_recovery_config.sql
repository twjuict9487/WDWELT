CREATE TABLE IF NOT EXISTS recovery_config (
  id TINYINT NOT NULL DEFAULT 1,
  password_hash VARBINARY(64) NOT NULL,
  salt VARBINARY(32) NOT NULL,
  hash_parameters JSON NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT ck_recovery_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
