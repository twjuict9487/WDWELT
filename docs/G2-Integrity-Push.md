# G2 database integrity, sessions, and Web Push

## Integrity cleanup

Dry Run is the default and does not write data:

```powershell
npm run db:integrity -- --config config/local/database.admin.json
```

Safe archive/unarchive repair requires a verified backup and explicit confirmation. It never deletes courses or progress:

```powershell
npm run db:integrity -- --config config/local/database.admin.json --apply --confirm APPLY-INTEGRITY-CLEANUP --backup-output runtime/backups
```

Removing a timetable slot archives its course after the last use. Re-adding the same normalized course name restores the original course ID and progress. Permanent deletion is a separate authenticated `DELETE /api/courses/:id` operation, allowed only after archival and requiring `confirmClassName` to exactly match.

## Persistent sessions

Sessions last 180 days and renew to 180 days when an authenticated request arrives with 30 days or less remaining. Logout revokes only that device. Password reset revokes all devices. Administrative revocation requires an explicit scope and confirmation:

```powershell
npm run sessions:revoke -- --config config/local/database.admin.json --username TeacherA --confirm REVOKE-SESSIONS
```

## Web Push

Generate the machine-local VAPID secret, which is excluded from Git, then restart the Host:

```powershell
npm run push:generate-vapid -- --output config/local/push.json --subject mailto:your-address@example.com
```

Settings can enable or disable each device, choose a 5/10/15/30 minute reminder, and send a test. iPhone users must first add the HTTPS site to the Home Screen. Notifications are queried from the current timetable at send time and are deduplicated per subscription, date, weekday, and period.

## Fast self-test

Open `/?debug=0`, sign in, open Settings, and select **執行所有安全檢查**. The panel performs authenticated, read-only checks of the current session, exposure/cookie policy, account-scoped integrity Dry Run, and Push configuration. It cannot apply cleanup or bypass authorization.
