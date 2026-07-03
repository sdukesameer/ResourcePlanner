# Resource Planner

A static, single-page web app for planning and tracking monthly billable hours across a project team. Built for service-based teams that need to check "are we hitting our billing target this month" without a spreadsheet.

No build step, no backend, no signup. Open `index.html` or deploy the folder as-is.

## Features

- **Resources** — add/rename/remove team members. Each card lets you set an **assigned start/end date** (leave either blank for indefinite — before/after that range the resource is excluded from totals and shown greyed, like a leave day). The month and week billing selects (Full 8h / Partial 4h / Inherit) also include an **Unbillable** option in the same dropdown, for a resource who's billable for only part of the month.
- **Calendar** — Monday–Sunday grid for the selected month. Out-of-month days are greyed and inert; weekends are greyed by default but still clickable (for logging weekend overtime). Today's cell has a red border. Each day shows total planned hours and a mini capacity bar.
- **Day editor** (click any weekday or weekend) —
  - Mark the day a **public holiday** (zeroes everyone).
  - Per resource: a **leave toggle** (separate from the billing dropdown) that greys out that resource's name/slider for the day; a billing dropdown (Full/Partial/Inherit on weekdays, Weekend/Full/Partial on weekends); and a **fine-tune slider** to nudge that resource's hours in 0.25h (full-billed) or 0.125h (partial-billed) steps. New leave tags default to red (matching the calendar legend's leave dot) with a colour picker to override.
  - A master **"All resources"** slider at the top scales every resource's fine-tune slider together for that one day.
- **Leaves & Holidays** — bulk-add a leave over a date range (weekends skipped automatically) with a label and colour tag; add/remove public holidays.
- **Calculations** — editable base + additional target hours (auto-rounds to nearest 10), summary cards (planned capacity, surplus vs. target, working days, holidays, leave/unbillable instances), a daily-hours bar chart with a dashed average-target line, a day-composition chart, a weekly breakdown table, and a resource × week matrix.
- **"Adjust effort to hit target"** — pick a start date and drag an effort % slider (3.125% / 0.25h steps) to preview and apply a uniform hours adjustment across every resource for every remaining working day in the month, e.g. to close a gap discovered mid-month.
- **Dark / light theme toggle**, persisted, defaulting to your system preference.
- **Export / Import** — download all data as JSON, or load a previously exported file back in.

## Hosting

This is a static site: `index.html`, `style.css`, `app.js`. Push the folder to a GitHub repo and connect it to Netlify (or any static host) with no build command and the publish directory set to the repo root.

## Data & storage

All data is stored in the browser's `localStorage` (key `resourcePlannerState_v1`), scoped per month. **Nothing is sent to a server** — this means:

- Data is per-browser, per-device. Opening the app on another machine or browser starts empty.
- Clearing site data/cookies for the deployed domain will erase your data.
- Use **Export data** regularly to back up, and **Import data** to move data between devices or browsers.

Theme preference is stored separately under `resourcePlannerTheme`.

## How the hours are calculated

For each resource, on each day, in priority order:

1. **Outside assigned start/end date** (if set) → 0h, shown as disabled/greyed.
2. **Public holiday** → 0h for everyone.
3. **Unbillable** (month- or week-level, set on the Resources tab) → 0h, shown as disabled/greyed.
4. **Leave** (toggled per day, or bulk-added on the Leaves tab) → 0h.
5. **Weekend** → 0h by default, unless a day-level Full/Partial override is set (for logging overtime).
6. **Weekday** → resolved as **day override → week override → month default → Full (8h)**, i.e. the most specific setting wins.

The resolved base (8h or 4h) is then adjusted by that day's fine-tune slider value (if any), clamped to a minimum of 0.

## Browser support

Any evergreen browser (Chrome, Edge, Firefox, Safari). Uses native `<input type="range">`, `<input type="date">`/`<input type="month">`, and inline SVG for charts — no external chart or UI library.

## Known limitations

- No multi-device sync (see Data & storage above).
- The month/week/day override hierarchy and the "Adjust effort to hit target" tool both operate on the currently viewed month only.
