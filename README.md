![Status](https://img.shields.io/badge/status-private%20fork-orange)
![License](https://img.shields.io/badge/license-AGPL--3.0-blue)
![Based on](https://img.shields.io/badge/based%20on-OctoFarm-9b59b6)

# OctoFarm-Redux

<div align="center">
  <img src="server/assets/images/navbar-logo.png" alt="OctoFarm-Redux logo" width="180px">

  <p align="center">
    OctoFarm-Redux is a personal, private fork of <a href="https://github.com/OctoFarm/OctoFarm">OctoFarm</a>, created by <a href="https://github.com/NotExpectedYet">James Mackay (NotExpectedYet)</a> and its contributors - a single pane of glass that combines multiple OctoPrint instances into one interface, monitoring and managing a 3D printer farm over the OctoPrint API and websocket systems.
  </p>

  <p align="center">
    <strong>Everything here rests on their work.</strong> The application, its architecture, and very nearly all of the
    code are theirs; they built it, and they gave it away for free under the AGPL. This fork only maintains what they
    made. Upstream OctoFarm is no longer being updated, so this repository keeps bugfixes and small improvements
    landing on top of it. It is not a public project, a successor, or a community fork - just their work, kept running.
  </p>
</div>

- [About](#about)
- [What's different from upstream](#whats-different-from-upstream)
- [Getting Started](#getting-started)
- [Installation Development](#installation-development)
- [Deployment](#deployment)
- [License](#license)
- [Acknowledgements](#acknowledgements)

## About

![OctoFarm Dashboard][DashboardScreenshot]

Everything described in this section is OctoFarm's own, built upstream by James Mackay and the project's
contributors. It is what you get from OctoFarm itself; the fork's own changes are in the
[next section](#whats-different-from-upstream).

OctoFarm was built to solve a problem anyone running multiple 3D printers on OctoPrint runs into: how do you manage
several printers from one place? Add your OctoPrint instances and it scans and keeps you up to date on the status of
your whole farm.

- Manage your OctoPrint instances, right down to triggering updates and plugin installs.
- Keep track of all the live data on your farm with a selection of views.
- Manage your OctoPrint file system: turn on housekeeping mode to check off files and bulk-delete them, filter the
  list down to just successful, failed, or never-printed files, and let an age-based sweep auto-select old files for
  you (with per-folder exclusions).
- Get an overview of your farm with the customisable dashboard.
- Manage and track filament/spool usage and cost on your farm.
- Track history and logs for all of your instances.
- Supports a wide variety of OctoPrint plugins to augment the system with more information.

## What's different from upstream

Everything in this section is a change *on top of* OctoFarm, not a replacement for it - the list is long only
because upstream development stopped, not because there was anything wrong with what was built. Some of these are
fixes that never landed upstream, some don't apply to a personal single-maintainer setup, and most of the rest is
bringing dependencies that have since gone end-of-life back up to date.

### New features

**File manager overhaul** - built entirely in this fork:
- Housekeeping mode: check off files (or "select all visible") and bulk-delete them in a single request, instead
  of one network round-trip per file.
- Filter the file list down to successful, failed, or never-printed files.
- Age-based sweep auto-selects files older than X days for review before deleting, with per-folder exclusions.
- Thumbnail hover preview, a density slider (normal/compact/ultra) to fit more files on screen, search that
  matches multiple words in any order, and a "Hide Folders" toggle.
- Copy a file directly to another printer - select one or more targets, with per-printer success/failure reporting.

**Everything else:**
- Corrected, actionable error messages when OctoPrint's own reported state contradicts itself (e.g. "already
  printing" while the printer shows disconnected), instead of a generic conflict message.
- Camera feeds now stream through OctoFarm itself (same-origin proxy) instead of the browser hitting each printer
  directly.
- Health check failures now name the specific check that failed (printer settings, required API, websocket,
  connection defaults, webcam settings, or history collection) instead of one generic "Failed health check!".
- Replaced the toilet-roll filament icon with a real spool.

### Improvements

- Cameras recover automatically after a stalled stream or after switching browser tabs away and back, instead of
  needing a manual page refresh.
- Print-finish time now displays in full (was silently truncated) and is now actually correct (was silently off by
  hours due to a container timezone bug).
- Panel/camera view cards stay a consistent height regardless of printer state.
- Static assets now cache correctly in the browser, so a deployed fix is guaranteed to reach you rather than
  possibly serving stale JS.
- Entire stack updated to current, supported versions - Node, MongoDB, Express, Mongoose, and all major
  dependencies (previously years out of date, several end-of-life).

### Bug fixes

- Alerts never actually worked - a data bug meant a configured alert never matched any printer, so nothing ever
  fired regardless of configuration.
- Spool cost was being silently under-reported on cancelled/failed prints (double-applied completion-ratio bug).
- Thumbnails could silently fail to save for any printer with API access control enabled.
- Printer setup could hang forever on "Setting Up" and never appear in the dashboard.
- Old temperature history was never actually cleaned up - over 2 million stale records had piled up.
- File-action errors (delete, move, select) showed the same vague message for every possible cause.
- A crashed background task used to bring down the entire app; it's now logged and the app keeps running.
- Login sessions no longer reset on every restart.
- Container shutdowns are now clean instead of abrupt (previously risked database corruption).
- A finished print could keep showing "Complete" and stale progress after the file was unselected.
- The file manager's upload queue could silently upload the wrong file and drop one from the queue when more than
  one upload was queued at once.
- Deleting or exporting several history/log databases from System Settings threw an error and didn't work at all.
- Wiping a database from System Settings could double-restart the server and double-send its response.
- Editing a filament history entry could silently wipe spool assignments from other tools on the same job.
- A task with no repeat interval rendered the literal word "undefined" in System > Tasks.
- "Files common to all printers" was wrong whenever a printer's file list hadn't finished caching yet.
- A missing/renamed asset served a misleading 200 OK web page instead of a real 404.
- Live-updating data (websocket URL) could be missing from the printer summary, breaking monitoring views for
  affected printers.
- A CSP misconfiguration could block the bundled theme's Google web font from loading.
- Server-sent events (live dashboard/monitoring updates) could get stuck buffering for seconds under compression.
- Filament cost totals could be wrong on prints that only used a non-zero tool number.
- Alert/webhook scripts could receive a permanent placeholder instead of the real history/error record ID.
- Spool weight bookkeeping and snapshot capture had inverted or incomplete guard conditions.
- A database write failure could silently look like it succeeded to the code that requested it.
- Task presets used by more than one scheduled task could cross-contaminate each other's settings.

### Security

- Closed a bypass where the registration page could be POSTed to directly and create an account even while
  registration was disabled in settings.
- The entire server-side template source tree used to be served as static files to anyone, logged in or not.
- Login and registration now have their own strict rate limit; previously the only limit in place was far too
  generous to stop password guessing.
- Removed a long-deprecated HTTP library and a stale dependency with a known sandbox-escape vulnerability.
- The live event stream no longer responds to unauthenticated requests.
- Your session cookie is no longer forwarded to third-party printers through the camera/file proxy.

### Developer / build

- Reproducible builds, content-hashed asset filenames, and an asset-manifest system (no more hardcoded bundle
  names).
- New smoke tests requiring no framework, database, or hardware: proxy behavior, cross-printer file transfer, and
  build/manifest verification.
- Working lint config (previously silently never ran) and a cleaned-up, drift-free dependency lockfile.
- Removed dead code (an old camera-snapshot path fully superseded by the streaming proxy), nine unused server
  dependencies, a Dockerfile that could no longer build this deployment, and the Patreon/supporter feature.
- Stopped shipping webpack source maps in the built image.
- Various icon/favicon fixes for correct rendering in Safari.

## Getting Started

Before installing, it's worth reading through upstream OctoFarm's own documentation for general usage - this fork
doesn't change how the application works day-to-day, only fixes and small additions on top:
[Getting Started](https://docs.octofarm.net/getting-started/)

## Installation Development

### Requirements
- Git
- NodeJS > v14
- npm

1. Clone the repo

```sh
git clone https://github.com/DaniSim-Dev/OctoFarm-Redux.git
```

2. Install the mono-repo eslint dependencies (eslint, prettier and nodemon)

```sh
npm install
```

3. Install server and client dependencies

```sh
npm run setup-dev
```

4. Create an `.env` file in the project root, e.g. `OctoFarm-Redux/.env`.
```dotenv
NODE_ENV=development
MONGO=mongodb://127.0.0.1:27017/octofarm
OCTOFARM_PORT=4000
```

5. Build the latest client
```sh
npm run build-client
```

6. (Optional) Watch for client changes, requires a secondary console.
```sh
npm run dev-client
```

7. Start the server

```sh
npm run server-dev
```
- The developer version uses nodemon for live server reloading on changes, and outputs all logs to the console.

## Deployment

The running instance is built from `monolithic.Dockerfile` (bundles MongoDB in one image) rather than the plain
`Dockerfile` at the repo root, which expects an external Mongo:

```sh
docker build -f monolithic.Dockerfile -t octofarm-redux:local .
```

Client-side changes need a client rebuild (`cd client && npm run build`) before committing - the prebuilt webpack
output is committed under `server/assets/`, and a client-only edit without a rebuild ships stale JS.

## License

This work [is licensed](LICENSE.txt) under the [GNU Affero General Public License v3](https://www.gnu.org/licenses/agpl-3.0.html).

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.

## Acknowledgements

**This project would not exist without the people below. None of the work in this fork is original in any meaningful
sense - it is maintenance on something other people designed, wrote, and released for free.**

- **[James Mackay (NotExpectedYet)](https://github.com/NotExpectedYet)** - the creator and original maintainer of
  [OctoFarm](https://github.com/OctoFarm/OctoFarm). He wrote the application this fork is built from: the printer
  management, the monitoring views, the file and filament managers, the history system, the OctoPrint API and
  websocket layer - the whole of it. Years of his work were given away under a free licence, which is the only
  reason a fork like this is possible at all. Every feature listed above sits on that foundation.
- **The [OctoFarm](https://github.com/OctoFarm/OctoFarm) contributors** - everyone who filed issues, wrote code,
  tested releases, translated the interface, and helped people in the community. Their work is in here too.
- **[Gina Häußge](https://octoprint.org/) and the OctoPrint project** - OctoFarm manages OctoPrint instances, so
  without OctoPrint neither upstream nor this fork would exist. OctoPrint is worth
  [supporting directly](https://octoprint.org/support-octoprint/).

If you found your way here looking for OctoFarm itself, go to
**[the original project](https://github.com/OctoFarm/OctoFarm)** first and read
[its documentation](https://docs.octofarm.net/). This fork is a personal one, carries no support, and makes no claim
to be its continuation.

Like upstream, this fork stays under the same [AGPL-3.0 licence](LICENSE.txt) it was given under.

[DashboardScreenshot]: screenshots/dashboard.png
