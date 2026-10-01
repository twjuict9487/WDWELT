-- WDWELT stores DATETIME values as Asia/Taipei wall-clock time.
-- Earlier releases wrote these specific columns with UTC_TIMESTAMP while
-- other DATETIME defaults used the MySQL host's Taipei system time.
UPDATE users
   SET timetable_updated_at = DATE_ADD(timetable_updated_at, INTERVAL 8 HOUR)
 WHERE timetable_updated_at IS NOT NULL;

UPDATE sessions
   SET expires_at = DATE_ADD(expires_at, INTERVAL 8 HOUR);

UPDATE course_progress
   SET updated_at = DATE_ADD(updated_at, INTERVAL 8 HOUR);

UPDATE password_reset_tokens
   SET created_at = DATE_ADD(created_at, INTERVAL 8 HOUR),
       expires_at = DATE_ADD(expires_at, INTERVAL 8 HOUR);
