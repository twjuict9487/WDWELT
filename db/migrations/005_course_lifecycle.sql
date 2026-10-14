ALTER TABLE courses
  ADD COLUMN archived_at DATETIME(3) NULL AFTER normalized_class_name,
  ADD KEY ix_courses_user_archived (user_id, archived_at);

UPDATE courses c
LEFT JOIN timetable_entries t ON t.course_id = c.id AND t.user_id = c.user_id
SET c.archived_at = CURRENT_TIMESTAMP(3)
WHERE t.course_id IS NULL;
