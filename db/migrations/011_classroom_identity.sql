CREATE TABLE learning_creators (
  user_id INT NOT NULL PRIMARY KEY,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  provisioned_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_learning_creator_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE learning_workspaces (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_by INT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_learning_workspace_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_learning_workspace_status CHECK(status IN ('active','archived'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE learning_roles (
  workspace_id INT NOT NULL,
  user_id INT NOT NULL,
  role VARCHAR(20) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  granted_by INT NOT NULL,
  PRIMARY KEY(workspace_id,user_id,role),
  CONSTRAINT fk_learning_role_workspace FOREIGN KEY(workspace_id) REFERENCES learning_workspaces(id) ON DELETE RESTRICT,
  CONSTRAINT fk_learning_role_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_learning_role_granter FOREIGN KEY(granted_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_learning_role CHECK(role IN ('manager','teacher'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE learning_classrooms (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  workspace_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  version INT NOT NULL DEFAULT 1,
  UNIQUE KEY uq_learning_classroom_scope(id,workspace_id),
  CONSTRAINT fk_learning_classroom_workspace FOREIGN KEY(workspace_id) REFERENCES learning_workspaces(id) ON DELETE RESTRICT,
  CONSTRAINT chk_learning_classroom_status CHECK(status IN ('active','archived'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE learning_teachers (
  classroom_id INT NOT NULL,
  workspace_id INT NOT NULL,
  user_id INT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  granted_by INT NOT NULL,
  PRIMARY KEY(classroom_id,user_id),
  CONSTRAINT fk_learning_teacher_classroom FOREIGN KEY(classroom_id,workspace_id) REFERENCES learning_classrooms(id,workspace_id) ON DELETE RESTRICT,
  CONSTRAINT fk_learning_teacher_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_learning_teacher_granter FOREIGN KEY(granted_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE learning_students (
  classroom_id INT NOT NULL,
  user_id INT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  joined_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(classroom_id,user_id),
  CONSTRAINT fk_learning_student_classroom FOREIGN KEY(classroom_id) REFERENCES learning_classrooms(id) ON DELETE RESTRICT,
  CONSTRAINT fk_learning_student_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE learning_invite_policies (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  classroom_id INT NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_by INT NOT NULL,
  CONSTRAINT fk_learning_policy_classroom FOREIGN KEY(classroom_id) REFERENCES learning_classrooms(id) ON DELETE RESTRICT,
  CONSTRAINT fk_learning_policy_user FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE learning_invite_tokens (
  token_hash BINARY(32) NOT NULL PRIMARY KEY,
  policy_id INT NOT NULL,
  created_by INT NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_learning_token_policy FOREIGN KEY(policy_id) REFERENCES learning_invite_policies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_learning_token_user FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE learning_notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  classroom_id INT NOT NULL,
  kind VARCHAR(30) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  read_at DATETIME(3) NULL,
  UNIQUE KEY uq_learning_notification(user_id,classroom_id,kind),
  CONSTRAINT fk_learning_notification_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_learning_notification_classroom FOREIGN KEY(classroom_id) REFERENCES learning_classrooms(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE learning_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_id INT NOT NULL,
  workspace_id INT NULL,
  classroom_id INT NULL,
  action VARCHAR(60) NOT NULL,
  details JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_learning_audit_scope(workspace_id,created_at),
  CONSTRAINT fk_learning_audit_actor FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_learning_audit_workspace FOREIGN KEY(workspace_id) REFERENCES learning_workspaces(id) ON DELETE RESTRICT,
  CONSTRAINT fk_learning_audit_classroom FOREIGN KEY(classroom_id) REFERENCES learning_classrooms(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
