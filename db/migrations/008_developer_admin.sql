ALTER TABLE users
  ADD COLUMN display_name VARCHAR(80) NULL AFTER username,
  ADD COLUMN class_name VARCHAR(40) NULL AFTER display_name,
  ADD COLUMN seat_number VARCHAR(20) NULL AFTER class_name,
  ADD COLUMN identity_labels JSON NULL AFTER seat_number,
  ADD COLUMN admin_notes VARCHAR(500) NULL AFTER identity_labels,
  ADD COLUMN account_role VARCHAR(20) NOT NULL DEFAULT 'user' AFTER admin_notes,
  ADD COLUMN account_status VARCHAR(20) NOT NULL DEFAULT 'active' AFTER account_role,
  ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE AFTER account_status,
  ADD COLUMN account_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) AFTER must_change_password,
  ADD KEY ix_users_identity (class_name, seat_number),
  ADD KEY ix_users_status (account_status);

CREATE TABLE developer_audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  action VARCHAR(50) NOT NULL,
  target_user_id INT NULL,
  details JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_developer_audit_created (created_at),
  KEY ix_developer_audit_target (target_user_id, created_at),
  CONSTRAINT fk_developer_audit_user FOREIGN KEY (target_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
