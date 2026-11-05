# MINDLOCK

MINDLOCK is a browser-extension and admin-dashboard productivity platform built for managed company laptops. The project combines a Supabase-backed admin dashboard with an employee browser extension that enforces scheduled website blocking and supports issue tracking.

## Project structure

- `admin/` — admin login and protected dashboard UI
- `extension/` — Chrome/Edge extension manifest and popup UI
- `supabase/migrations/001_initial_schema.sql` — PostgreSQL schema and RLS starter logic

## Quick start

1. Copy the Supabase credentials into a secure config before deploying.
2. Start a local static web server:
   - `python -m http.server 8000`
3. Open `http://localhost:8000/admin/index.html` to use the admin app.
4. Load the extension from `extension/` in Chrome with Developer mode enabled.

## Supabase setup

- Create a Supabase project.
- Run the SQL in `supabase/migrations/001_initial_schema.sql`.
- Set up the initial admin user through Supabase Auth Admin, not by inserting into auth tables manually.
- Use `sys@admin.com` / `admin123` only as a development bootstrap credential; the user must change the password after first login.

## Notes

This repository intentionally provides a working front-end scaffold and database schema with realistic structure and logic. In production, replace demo data and extension blocking logic with your Supabase project-specific credentials and server-side policies.
