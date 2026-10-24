CREATE TABLE learning_activities (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  classroom_id INT NOT NULL,
  title VARCHAR(120) NOT NULL,
  scheduled_at DATETIME(3) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  version INT NOT NULL DEFAULT 1,
  active_group_id INT NULL,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  created_by INT NOT NULL,
  started_at DATETIME(3) NULL,
  ended_at DATETIME(3) NULL,
  KEY ix_learning_activity_class(classroom_id,id),
  CONSTRAINT fk_learning_activity_class FOREIGN KEY(classroom_id) REFERENCES learning_classrooms(id) ON DELETE RESTRICT,
  CONSTRAINT fk_learning_activity_creator FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_learning_activity_state CHECK(status IN ('draft','live','ended','cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE learning_participants (
  activity_id INT NOT NULL,
  user_id INT NOT NULL,
  excluded BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY(activity_id,user_id),
  CONSTRAINT fk_learning_participant_activity FOREIGN KEY(activity_id) REFERENCES learning_activities(id) ON DELETE RESTRICT,
  CONSTRAINT fk_learning_participant_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE learning_groups (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  activity_id INT NOT NULL,
  name VARCHAR(80) NOT NULL,
  position INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  UNIQUE KEY uq_learning_group_scope(id,activity_id),
  UNIQUE KEY uq_learning_group_position(activity_id,position),
  CONSTRAINT fk_learning_group_activity FOREIGN KEY(activity_id) REFERENCES learning_activities(id) ON DELETE RESTRICT,
  CONSTRAINT chk_learning_group_state CHECK(status IN ('pending','presenting','collecting','completed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
ALTER TABLE learning_activities ADD CONSTRAINT fk_learning_active_group FOREIGN KEY(active_group_id,id) REFERENCES learning_groups(id,activity_id) ON DELETE RESTRICT;

CREATE TABLE learning_group_members (
  activity_id INT NOT NULL,
  user_id INT NOT NULL,
  group_id INT NOT NULL,
  PRIMARY KEY(activity_id,user_id),
  CONSTRAINT fk_learning_member_participant FOREIGN KEY(activity_id,user_id) REFERENCES learning_participants(activity_id,user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_learning_member_group FOREIGN KEY(group_id,activity_id) REFERENCES learning_groups(id,activity_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE learning_criteria (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  activity_id INT NOT NULL,
  name VARCHAR(80) NOT NULL,
  position INT NOT NULL,
  UNIQUE KEY uq_learning_criterion_scope(id,activity_id),
  UNIQUE KEY uq_learning_criterion_position(activity_id,position),
  CONSTRAINT fk_learning_criterion_activity FOREIGN KEY(activity_id) REFERENCES learning_activities(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE learning_rounds (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  activity_id INT NOT NULL,
  group_id INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'collecting',
  token_hash BINARY(32) NOT NULL,
  opened_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  closed_at DATETIME(3) NULL,
  UNIQUE KEY uq_learning_round_group(activity_id,group_id),
  UNIQUE KEY uq_learning_round_scope(id,activity_id),
  UNIQUE KEY uq_learning_round_token(token_hash),
  CONSTRAINT fk_learning_round_group FOREIGN KEY(group_id,activity_id) REFERENCES learning_groups(id,activity_id) ON DELETE RESTRICT,
  CONSTRAINT chk_learning_round_state CHECK(status IN ('collecting','closed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE learning_eligibility (
  round_id INT NOT NULL,
  activity_id INT NOT NULL,
  reviewer_id INT NOT NULL,
  group_id INT NOT NULL,
  PRIMARY KEY(round_id,reviewer_id),
  CONSTRAINT fk_learning_eligibility_round FOREIGN KEY(round_id,activity_id) REFERENCES learning_rounds(id,activity_id) ON DELETE RESTRICT,
  CONSTRAINT fk_learning_eligibility_participant FOREIGN KEY(activity_id,reviewer_id) REFERENCES learning_participants(activity_id,user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_learning_eligibility_group FOREIGN KEY(group_id,activity_id) REFERENCES learning_groups(id,activity_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE learning_evaluations (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  round_id INT NOT NULL,
  activity_id INT NOT NULL,
  reviewer_id INT NOT NULL,
  request_key VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_hash BINARY(32) NOT NULL,
  comment VARCHAR(500) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  voided BOOLEAN NOT NULL DEFAULT FALSE,
  void_reason VARCHAR(500) NULL,
  UNIQUE KEY uq_learning_evaluation_reviewer(round_id,reviewer_id),
  UNIQUE KEY uq_learning_evaluation_request(reviewer_id,request_key),
  UNIQUE KEY uq_learning_evaluation_scope(id,activity_id),
  CONSTRAINT fk_learning_evaluation_eligibility FOREIGN KEY(round_id,reviewer_id) REFERENCES learning_eligibility(round_id,reviewer_id) ON DELETE RESTRICT,
  CONSTRAINT fk_learning_evaluation_round FOREIGN KEY(round_id,activity_id) REFERENCES learning_rounds(id,activity_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE learning_scores (
  evaluation_id INT NOT NULL,
  activity_id INT NOT NULL,
  criterion_id INT NOT NULL,
  score TINYINT NOT NULL,
  PRIMARY KEY(evaluation_id,criterion_id),
  CONSTRAINT fk_learning_score_evaluation FOREIGN KEY(evaluation_id,activity_id) REFERENCES learning_evaluations(id,activity_id) ON DELETE RESTRICT,
  CONSTRAINT fk_learning_score_criterion FOREIGN KEY(criterion_id,activity_id) REFERENCES learning_criteria(id,activity_id) ON DELETE RESTRICT,
  CONSTRAINT chk_learning_score CHECK(score BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
