# LOCTIV

LOCTIV is a browser-extension and admin-dashboard productivity platform built for managed company laptops. The project combines a Supabase-backed admin dashboard with an employee browser extension that enforces scheduled website blocking and supports issue tracking.

## Project structure

- `admin/` — admin login and protected dashboard UI
- `extension/` — Chrome/Edge extension manifest and popup UI
- `device-agent/` — Windows PowerShell agent and elevated installer for secure device heartbeats
- `supabase/migrations/001_initial_schema.sql` — PostgreSQL schema and RLS starter logic
- `supabase/migrations/002_employee_user_id.sql` — employee user IDs and active assignment constraints
- `supabase/migrations/003_ticket_conversations.sql` — ticket workflow, messages, attachments, privacy policies, and realtime
- `supabase/migrations/004_admin_dashboard_workflows.sql` — sequential employee/laptop IDs, admin workflow policies, and scheduled website blocking
- `supabase/migrations/005_admin_device_details.sql` — laptop MAC address storage and staff profile updates
- `supabase/migrations/006_blocking_rule_employee_targets.sql` — optional employee-specific website blocking policies
- `supabase/migrations/007_device_registration_monitoring.sql` — secure device registration, assignment history, and heartbeat connection logs
- `supabase/migrations/008_settings_retention_and_assignment.sql` — persistent settings, retention cleanup, and assignment expiry
- `supabase/functions/device-registration/` — admin-only device registration and revocation endpoint
- `supabase/functions/device-heartbeat/` — credential-verified laptop heartbeat endpoint
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
- Deploy the `device-registration` and `device-heartbeat` Supabase Edge Functions. Keep `SUPABASE_SERVICE_ROLE_KEY` in the Edge Function environment only; never put it in `admin/config.js`, the extension, or the Windows agent.
- Deploy from the project root with `supabase functions deploy device-registration` and `supabase functions deploy device-heartbeat --no-verify-jwt`. The registration endpoint checks the admin JWT itself; the heartbeat endpoint authenticates the device credential.
- Deploy the employee account function with `supabase functions deploy employee-account`. The admin dashboard sends the employee's temporary password to this protected function; it is never stored in the `employees` table.
- Redeploy `employee-account` after pulling changes to password reset behavior; an older deployed version treats reset requests as new-account requests and may report a misleading email validation error.
- If the dashboard reports that the employee-account service could not be reached, run the deployment command from the repository root and confirm the function is available at `https://YOUR-PROJECT.supabase.co/functions/v1/employee-account`. Serve the dashboard from a local web server such as `python -m http.server 8000`, not a `file://` page.
- Create employee accounts from the admin dashboard after deploying `employee-account`; it creates the Supabase Auth user and matching `profiles`, `employees`, and `user_roles` rows automatically. Create the first administrator account through Supabase Auth, then create its profile and administrator role during initial setup. Do not insert users directly into Supabase's `auth` tables.
- Deactivate users with ticket history instead of deleting their profiles; the conversation migration restricts deletion so ticket records and sender history are retained.
- Add the project URL and public anon key to both `admin/config.js` and `extension/config.js`. Never put a Supabase service-role key in the dashboard or extension.
- Enable the extension for incognito use in the browser's extension settings if the organization's policy requires blocking there; browsers do not allow an extension to silently enable itself in incognito.
- Apply and verify your Supabase Auth, Storage, and Realtime settings before deployment. Ticket attachments use the private `ticket-attachments` bucket created by migration 003.

## Notes

Tickets and messages are stored in Supabase and protected by row-level security. Employees can only access their own tickets; internal IT notes are restricted to support staff. The admin ticket screen uses Supabase Realtime with polling as a fallback, and the extension checks for replies and status changes while its background worker is running. Employee and laptop IDs are generated by database sequences and ticket numbers are assigned by the sequence created in migration 003; existing IDs are preserved.

The admin dashboard reads employee, laptop, request, activity, and blocking policy data from Supabase; it does not seed demo rows. Website policies are stored in `website_blocking_rules` and synchronized by the extension while an employee is signed in. Each policy can target one employee or all employees, and applies only on configured weekdays and within its configured times. Admin account email and password changes use Supabase Auth.

Laptop online status is based on device-agent heartbeats, not browser or extension activity. Device registration returns a one-time credential for provisioning an authorized Windows monitoring agent; the dashboard does not persist that credential. The agent must POST `{"device_id":"DEV-...","credential":"..."}` to the deployed `device-heartbeat` Edge Function at least once per minute. Store the credential securely on the managed device and never embed the Supabase service-role key. The dashboard reports Online for a heartbeat within three minutes, Offline after that, Not Connected for registered devices without a heartbeat, and Unregistered without an active registration. Connection and assignment history are retained in Supabase.

To provision an approved Windows laptop, copy its one-time credential and Device ID from the admin's Register Device dialog, then run an elevated Windows PowerShell 5.1 session from `device-agent/`:

```powershell
$credential = Read-Host "One-time device credential" -AsSecureString
.\Install-MindlockDeviceAgent.ps1 -SupabaseUrl "https://YOUR-PROJECT.supabase.co" -SupabaseAnonKey "YOUR-PUBLIC-ANON-KEY" -DeviceId "DEV-YOUR-DEVICE-ID" -Credential $credential
```

The installer stores the credential with machine-scoped DPAPI and restricts the configuration directory to Administrators and SYSTEM. The scheduled task sends heartbeats every minute as SYSTEM. MAC addresses should be collected through an authorized IT inventory process and entered in the dashboard; the browser does not attempt to discover them.
