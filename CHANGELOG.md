# Changelog

## 1.2.12 - November 19, 2026

- Open tickets from admin notifications and prevent employee replies or attachments after closure.
- Register a laptop automatically when it is assigned, and show unassigned devices as unregistered.
- Organize single and bulk website schedules in tabs and remove the dashboard Needs attention card.

## 1.2.13 - November 19, 2026

- Send employee analytics and device heartbeats every 30 seconds.
- Refresh admin analytics when employee activity arrives and show monitoring status from the latest heartbeat.

## 1.2.11 - November 18, 2026

- Added per-employee website usage reporting for time spent, visits, and browser-reported transfer size.
- Persisted extension usage tracking across service-worker restarts and attributed records to the signed-in employee.
- Added bulk website schedules that allow access during configured lunch hours.
- Added database validation and employee attribution for website usage records.

## 1.2.1 - November 14, 2026

- Added permanent employee and website-policy deletion actions.
- Added employee and laptop filters.
- Added one-minute policy and website-usage synchronization.
- Fixed exact schedule end-time behavior and removed timezone selection from the blocking form.
- Added employee-ticket notifications for administrators and IT staff.
- Added terminated-assignment cleanup and persisted dashboard theme colors.
- Repaired extension authentication headers and dynamic blocking rule loading.
- Updated the admin and employee extension release labels to 1.2.1.
- Improved navigation branding, employee table ordering, and in-page controls.
