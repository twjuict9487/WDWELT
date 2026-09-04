CREATE TABLE IF NOT EXISTS users (
  id INT NOT NULL AUTO_INCREMENT,
  username VARCHAR(50) NOT NULL,
  normalized_username VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  password_salt VARBINARY(32) NOT NULL,
  password_hash VARBINARY(64) NOT NULL,
  password_parameters JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  timetable_updated_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_normalized_username (normalized_username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash BINARY(32) NOT NULL,
  user_id INT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY (token_hash),
  KEY ix_sessions_expires_at (expires_at),
  KEY ix_sessions_user_id (user_id),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS courses (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  class_name VARCHAR(20) NOT NULL,
  normalized_class_name VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_courses_user_class (user_id, normalized_class_name),
  UNIQUE KEY uq_courses_id_user (id, user_id),
  CONSTRAINT fk_courses_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS timetable_entries (
  user_id INT NOT NULL,
  weekday TINYINT UNSIGNED NOT NULL,
  period TINYINT UNSIGNED NOT NULL,
  course_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id, weekday, period),
  KEY ix_timetable_course_user (course_id, user_id),
  CONSTRAINT chk_timetable_weekday CHECK (weekday BETWEEN 1 AND 5),
  CONSTRAINT chk_timetable_period CHECK (period BETWEEN 1 AND 8),
  CONSTRAINT fk_timetable_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_timetable_course_user FOREIGN KEY (course_id, user_id) REFERENCES courses (id, user_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS course_progress (
  course_id BIGINT UNSIGNED NOT NULL,
  progress VARCHAR(120) NOT NULL,
  note VARCHAR(300) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (course_id),
  CONSTRAINT fk_progress_course FOREIGN KEY (course_id) REFERENCES courses (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
