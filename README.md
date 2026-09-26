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
- [Support](#support)

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
- The list resyncs itself after a file or folder is added, removed, or bulk-updated.

**Torch** - turn a printer's light on and off from the command panel. A real toggle that reflects the light's
actual state, and it tells you when the light cannot come on because the printer's PSU is off, instead of
claiming success.

**Maintenance Mode** - suspends PSU Control's automatic power-off from the printer's command panel, so a printer
stays powered while you calibrate it, level the bed, or work on it, instead of the PSU cutting out on you
mid-task because the printer counts as idle. A farm-wide banner names every printer currently left that way, so
one does not sit powered up overnight because somebody forgot, and it appears the moment you toggle it rather
than on the next 30-second poll. Needs the "PSU Control - Maintenance Mode" OctoPrint plugin, so it stays off
until switched on under System > Server > Features.

**Spool manager** - reworked so the numbers on screen can be trusted:
- Every spool carries a short number you can write on a sticker and put on the physical roll. Leave it blank and
  it takes the next free one, duplicates and half-numbers are refused, and a deleted spool's number is never
  handed out again in case its sticker is still about.
- That number shows in the spool manager, the overview table and every spool picker on the printer views
  ("#1 3DJake ecoPLA Black (901g) - PLA"), and both the search box and the sort dropdown work on it.
- "Used (g)" now shows what has been used. It used to show what was left, and opening a spool for editing copied
  that figure into the used field, so a spool could be marked empty just by opening and saving it.
- Remaining has a read-only column of its own beside it, and sorting by Remaining now really sorts by remaining.
- A pre-flight check before printing: what the file needs is compared against what is left on the spool assigned
  to that tool, and you are told before the print starts rather than when it runs dry. The file list flags a file
  the spool cannot finish, and Multi-Print asks once for the whole batch. It only warns and always offers "print
  anyway" - both numbers are estimates - it says nothing at all unless a spool is actually assigned and the file
  has been analysed, and it can be switched off under System > Server > Filament.
- Filament accounting corrected throughout: cost on cancelled prints, totals on a non-zero tool, spool
  assignments surviving a history edit, and the weight bookkeeping guards (see the fixes below).

**Camera streaming** - camera feeds stream through OctoFarm itself (a same-origin proxy) instead of the browser
connecting to every printer directly, which is also what stopped Safari loading them at all.

**Everything else:**
- Corrected, actionable error messages when OctoPrint's own reported state contradicts itself (e.g. "already
  printing" while the printer shows disconnected), instead of a generic conflict message.
- Health check failures now name the specific check that failed (printer settings, required API, websocket,
  connection defaults, webcam settings, or history collection) instead of one generic "Failed health check!".
- Replaced the toilet-roll filament icon with a real spool.

### Improvements

- Cameras recover automatically after a stalled stream or after switching browser tabs away and back, instead of
  needing a manual page refresh - and a camera showing an unchanging picture (a dark enclosure overnight) is no
  longer mistaken for a dead one and reconnected all night.
- The whole interface stays responsive after leaving a tab in the background. Buttons could previously go dead
  with no error at all, because abandoned live connections used up every socket the browser allows per site and
  new requests simply queued forever behind them.
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
- Opening a spool in the Spool Manager and saving it, without changing anything, silently marked the spool as
  fully used: the "Used" column was showing what was left, and the editor wrote that back into used.
- Saving any filament setting, while "allow single spools on multiple printers" happened to be off, detached
  every spool from every printer - even though spools can still be assigned one at a time when it is off.
- Every error message in the app rendered grey instead of red, so failures looked like ordinary notices.
- A lingering websocket handshake from a printer being reconnected could crash the entire server, taking
  monitoring for the whole farm down with it.
- A camera that failed to reconnect when returning to a tab never tried again, and a partially delivered frame
  left the picture half grey with nothing to recover it.
- The camera proxy dropped healthy cameras 30 seconds after a tab was backgrounded, mistaking the browser having
  stopped reading for the printer having gone quiet.
- Quick Connect's state could stop syncing entirely if one button was missing from the page.
- The Torch and Maintenance Mode toggles could double-fire and flip straight back, or deadlock a button
  permanently.
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
  without OctoPrint neither upstream nor this fork would exist.

If you found your way here looking for OctoFarm itself, go to
**[the original project](https://github.com/OctoFarm/OctoFarm)** first and read
[its documentation](https://docs.octofarm.net/). This fork is a personal one, maintained for a single farm, and
makes no claim to be its continuation.

Like upstream, this fork stays under the same [AGPL-3.0 licence](LICENSE.txt) it was given under.

## Support

OctoFarm-Redux is free. If the work in this fork - the fixes and additions listed above - has been useful to you,
you can leave a tip at [ko-fi.com/danisim](https://ko-fi.com/danisim). Entirely optional; nothing is locked behind
it.

[DashboardScreenshot]: screenshots/dashboard.png
