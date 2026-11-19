# LOCTIV

LOCTIV is a browser-extension and admin-dashboard productivity platform built for managed company laptops. The project combines a Supabase-backed admin dashboard with an employee browser extension that enforces scheduled website blocking and supports issue tracking.

## Project structure

- `admin/` — admin login and protected dashboard UI
- `extension/` — Chrome/Edge extension manifest and popup UI
- `supabase/migrations/001_initial_schema.sql` — PostgreSQL schema and RLS starter logic
- `supabase/migrations/002_employee_user_id.sql` — employee user IDs and active assignment constraints
- `supabase/migrations/003_ticket_conversations.sql` — ticket workflow, messages, attachments, privacy policies, and realtime
- `supabase/migrations/004_admin_dashboard_workflows.sql` — sequential employee/laptop IDs, admin workflow policies, and scheduled website blocking
- `supabase/migrations/005_admin_device_details.sql` — laptop MAC address storage and staff profile updates
- `supabase/migrations/006_blocking_rule_employee_targets.sql` — optional employee-specific website blocking policies
- `supabase/migrations/007_device_registration_monitoring.sql` — secure device registration, assignment history, and heartbeat connection logs
- `supabase/migrations/008_settings_retention_and_assignment.sql` — persistent settings, retention cleanup, and assignment expiry
- `supabase/migrations/009_blocking_policy_relationship.sql` — link blocking rules to schedules and schedule assignments
- `supabase/migrations/010_blocking_schedule_metadata.sql` — schedule descriptions and time zones
- `supabase/migrations/011_backfill_blocking_schedule_links.sql` — backfill unambiguous schedule links
- `supabase/migrations/012_ticket_notifications.sql` — notifications for newly submitted employee tickets
- `supabase/migrations/013_admin_ticket_notifications_and_employee_deletion.sql` — admin ticket update notifications and safe deletion of accounts with ticket history
- `supabase/migrations/014_allow_ticket_sender_anonymization.sql` — allow profile deletion to anonymize ticket message sender references while preserving immutable message content
- `supabase/migrations/015_extension_employee_heartbeats.sql` — heartbeat database updates, two-minute stale handling, and Realtime publication updates
- `supabase/migrations/016_authenticated_extension_heartbeats.sql` — employee-authenticated heartbeat RPC wrapper
- `supabase/functions/device-registration/` — admin-only device registration and revocation endpoint
- `supabase/functions/device-heartbeat/` — credential-verified laptop heartbeat endpoint
- `supabase/functions/extension-heartbeat/` — legacy JWT-authenticated heartbeat endpoint; the extension now calls the authenticated database RPC directly
- `supabase/functions/employee-account/` — administrator-only employee Auth account and profile creation endpoint

## Quick start

1. Configure the Supabase project as described below.
2. Start a local static web server from the repository root:
   - `python -m http.server 8000`
3. Open `http://localhost:8000/admin/index.html` to use the admin app.
4. Load the extension from `extension/` in Chrome with Developer mode enabled.

## Supabase setup

- Create a Supabase project.
- Run the SQL in `supabase/migrations/001_initial_schema.sql`.
- For an existing installation, run `supabase/migrations/002_employee_user_id.sql` after the initial schema.
- Run `supabase/migrations/003_ticket_conversations.sql` after the first two migrations.
- Run `supabase/migrations/004_admin_dashboard_workflows.sql` after the first three migrations.
- Run `supabase/migrations/005_admin_device_details.sql` after migration 004.
- Run `supabase/migrations/006_blocking_rule_employee_targets.sql` after migration 005 to enable policies for one employee; policies can also apply to all employees.
- Run `supabase/migrations/007_device_registration_monitoring.sql` after migration 006.
- Run `supabase/migrations/008_settings_retention_and_assignment.sql` after migration 007.
- Run `supabase/migrations/009_blocking_policy_relationship.sql` after migration 008 to link blocked domains to their schedules and enable schedule assignment policies.
- Run `supabase/migrations/010_blocking_schedule_metadata.sql` after migration 009 to add schedule descriptions and explicit timezones. Existing schedules default to `Asia/Manila`.
- Run `supabase/migrations/011_backfill_blocking_schedule_links.sql` after migration 010 to backfill unambiguous domain-to-schedule links without overwriting existing links.
- Run `supabase/migrations/012_ticket_notifications.sql` to notify administrators and IT staff about new employee tickets.
- Run `supabase/migrations/013_admin_ticket_notifications_and_employee_deletion.sql` after migration 012 to notify administrators about IT staff updates and allow employee account deletion while retaining ticket history.
- Run `supabase/migrations/014_allow_ticket_sender_anonymization.sql` after migration 013 so deleting an employee can clear ticket message sender IDs without changing or deleting message content.
- Run `supabase/migrations/015_extension_employee_heartbeats.sql` after migration 014 to add the authenticated extension heartbeat RPC and two-minute stale connection handling.
- Run `supabase/migrations/016_authenticated_extension_heartbeats.sql` after migration 015 to enable employee-authenticated heartbeats without an Edge Function deployment.
- Run `supabase/migrations/017_analytics_daily_retention.sql` after migration 016 to install the `pg_cron` job that deletes old usage logs daily at 00:15 UTC, based on the editable Analytics retention setting.
- Run `supabase/migrations/018_employee_analytics_and_bulk_schedules.sql` after migration 017 to attribute usage to employees, authorize employee-owned usage inserts, and enable atomic bulk work/lunch schedules.
- Run `supabase/migrations/019_closed_ticket_replies_and_device_assignment.sql` after migration 018 to block replies and uploads on closed tickets and deactivate registrations for unassigned laptops.
- Run `supabase/migrations/020_philippines_timezone.sql` after migration 019 to align saved schedules and the company timezone with Asia/Manila.
- Run `supabase/migrations/021_realtime_employee_analytics.sql` after migration 020 to publish employee activity inserts for immediate analytics refresh.
- Run `supabase/migrations/022_employee_schedules_attendance.sql` after migration 021 to enable employee schedules, authenticated Clock In / Clock Out, attendance sessions, work-status synchronization, and automatic work-session cutoff.
- Run `supabase/migrations/023_ticket_reporting_and_category_access.sql` after migration 022 to enable the expanded ticket report categories and authenticated category lookup from the employee extension.
- Run `supabase/migrations/024_software_ticket_categories.sql` after migration 023 to replace laptop hardware ticket categories with software, slow server, 404 Not Found, and 403 Forbidden categories.
- Run `supabase/migrations/025_resolved_ticket_retention.sql` after migration 024 to automatically delete Resolved/Closed tickets older than the configured `resolved_ticket_cleanup_days` setting each day. Related conversations, assignments, notes, and attachment metadata cascade with the ticket; linked laptop change requests are retained with a null ticket reference.
- Run `supabase/migrations/026_schedule_based_website_blocking.sql` after migration 025 to add reusable default website templates and employee-specific blocking policies linked to existing employee schedules.
- Deploy the `device-registration` and `device-heartbeat` Supabase Edge Functions. Keep `SUPABASE_SERVICE_ROLE_KEY` in the Edge Function environment only; never put it in `admin/config.js` or the extension.
- Deploy legacy endpoints with `supabase functions deploy device-registration` and `supabase functions deploy device-heartbeat --no-verify-jwt` if they are still used. The registration endpoint checks the admin JWT itself; legacy device heartbeat authenticates the registration credential.
- Deploy the employee account function with `supabase functions deploy employee-account`. The admin dashboard sends the employee's temporary password to this protected function; it is never stored in the `employees` table.
- Redeploy `employee-account` after pulling changes to account creation, deletion, or password reset behavior.
- If the dashboard reports that the employee-account service could not be reached, run the deployment command from the repository root and confirm the function is available at `https://YOUR-PROJECT.supabase.co/functions/v1/employee-account`. Serve the dashboard from a local web server such as `python -m http.server 8000`, not a `file://` page.
- Create employee accounts from the admin dashboard after deploying `employee-account`; it creates the Supabase Auth user and matching `profiles`, `employees`, and `user_roles` rows automatically. Create the first administrator account through Supabase Auth, then create its profile and administrator role during initial setup. Do not insert users directly into Supabase's `auth` tables.
- Employee account deletion retains ticket, message, attachment, assignment, and note history; references to the deleted profile are cleared by migrations 013 and 014.
- Add the project URL and public anon key to both `admin/config.js` and `extension/config.js`. Never put a Supabase service-role key in the dashboard or extension.
- Enable the extension for incognito use in the browser's extension settings if the organization's policy requires blocking there; browsers do not allow an extension to silently enable itself in incognito.
- Apply and verify your Supabase Auth, Storage, and Realtime settings before deployment. Ticket attachments use the private `ticket-attachments` bucket created by migration 003.

## Notes

Tickets and messages are stored in Supabase and protected by row-level security. Employees can only access their own tickets; internal IT notes are restricted to support staff. The admin ticket screen uses Supabase Realtime with polling as a fallback, and the extension checks for replies and status changes while its background worker is running. Employee and laptop IDs are generated by database sequences and ticket numbers are assigned by the sequence created in migration 003; existing IDs are preserved.

The admin dashboard reads employee, laptop, request, activity, and blocking policy data from Supabase; it does not seed demo rows. Website policies use `blocking_schedules` for timing and scope, `website_blocking_rules` for domains, and `blocking_schedule_assignments` for specific employees; the extension synchronizes applicable policies while an employee is signed in and falls back to the legacy flat rule columns when migration 009 is not yet applied. Each policy can target one employee or all employees, and applies only on configured weekdays and within its configured times. Schedule times, the live dashboard clock, and daily analytics all use Philippine time (Asia/Manila). Bulk schedules split work hours into a before-lunch and after-lunch block so those domains are allowed during lunch; overlapping policies can still block the same domains. Website usage analytics show the last seven Philippine calendar days and per-employee website totals, and refresh with the dashboard's automatic sync. Time measures extension-observed time in the focused browser window's active tab, not proof of work productivity. Data usage is estimated from browser-reported resource sizes and may be inaccurate for cached or cross-origin resources. The Analytics retention setting controls a daily database cleanup of older usage records. Admin account email and password changes use Supabase Auth.

Laptop connection status is based on authenticated employee extension heartbeats, not proof that the Windows laptop itself is powered on. The signed-in Chrome/Edge extension sends one heartbeat every 30 seconds to the employee-authenticated database RPC, independently of whether the employee has any blocking schedules. The RPC derives the employee profile from the Supabase Auth session, validates the employee, active laptop assignment, and device registration, then updates `last_seen_at`, the extension version, and connection history. The dashboard reports Online for a heartbeat within two minutes, Offline after two minutes, Not Connected for registered devices without a heartbeat, and Unregistered without an active registration. Browser closure or extension disablement may stop heartbeats. The service-role-only RPC remains inaccessible to extension clients.

To connect a newly added laptop: add it in Laptop inventory and assign it to an active employee; the admin dashboard registers it automatically. If device registration fails, the assignment remains saved and the dashboard reports the failure while the laptop remains Unregistered. Then install the LOCTIV extension in Chrome or Edge on that laptop and have the assigned employee sign in. The extension discovers the employee's assigned registered laptop and starts heartbeats automatically; no one-time device credential or separate agent setup is required. The dashboard's Connection and Last Seen fields update after the first successful heartbeat. Reassigning a laptop refreshes its registration for the new employee.

After applying migration 018, reload/update the extension on managed browsers to enable employee-attributed analytics and browser-reported MB estimates. The Website Blocking section's Bulk work-hours form accepts multiple domains, employee or all-employee scope, weekdays, work hours, and lunch hours. For example, 08:00–17:00 with lunch 12:00–13:00 creates two blocking windows and leaves the selected sites accessible during lunch. After applying migration 019, employees cannot reply or attach files to Closed tickets; deploy the updated v1.2.12 extension to show the closed-ticket state in the employee UI.

Apply migration 016 after migration 015 and reload the extension to enable heartbeats. No `extension-heartbeat` Edge Function deployment is required; the extension calls the database RPC with the employee's Auth session. If the extension reports that the authenticated heartbeat RPC is unavailable, confirm migration 016 was applied to the same Supabase project configured in `extension/config.js`.
