![Status](https://img.shields.io/badge/status-private%20fork-orange)
![License](https://img.shields.io/badge/license-AGPL--3.0-blue)
![Based on](https://img.shields.io/badge/based%20on-OctoFarm-9b59b6)

# OctoFarm-Redux

<div align="center">
  <img src="server/assets/images/navbar-logo.png" alt="OctoFarm-Redux logo" width="180px">

  <p align="center">
    OctoFarm-Redux is a personal, private fork of <a href="https://github.com/OctoFarm/OctoFarm">OctoFarm</a> - a single pane of glass that combines multiple OctoPrint instances into one interface, monitoring and managing a 3D printer farm over the OctoPrint API and websocket systems.
  </p>

  <p align="center">
    Upstream OctoFarm has gone unmaintained, so this fork exists to keep bugfixes and small improvements landing on top of it. It is not a public project or a community fork - just an actively maintained, improved version kept up to date for personal use.
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

OctoFarm was built to solve a problem anyone running multiple 3D printers on OctoPrint runs into: how do you manage
several printers from one place? Add your OctoPrint instances and it scans and keeps you up to date on the status of
your whole farm.

- Manage your OctoPrint instances, right down to triggering updates and plugin installs.
- Keep track of all the live data on your farm with a selection of views.
- Manage your OctoPrint file system: multi-select bulk delete via housekeeping mode, an age-based sweep to
  auto-select old files (with per-folder exclusions), and filters by last print result (success/failed/unprinted).
- Get an overview of your farm with the customisable dashboard.
- Manage and track filament/spool usage and cost on your farm.
- Track history and logs for all of your instances.
- Supports a wide variety of OctoPrint plugins to augment the system with more information.

## What's different from upstream

This fork carries fixes and small improvements that either never landed upstream or don't apply to a personal,
single-maintainer setup. Upstream OctoFarm was left on years-old, end-of-life dependencies with a number of
long-standing bugs; this fork is a full modernization plus everything below.

### New features

- Copy a file directly to another printer - select one or more targets, with per-printer success/failure reporting.
- Corrected, actionable error messages when OctoPrint's own reported state contradicts itself (e.g. "already
  printing" while the printer shows disconnected), instead of a generic conflict message.
- Camera feeds now stream through OctoFarm itself (same-origin proxy) instead of the browser hitting each printer
  directly.
- File manager house-keeping ("delete files older than X days") can now exclude specific folders from the sweep.

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

### Security

- Removed a long-deprecated HTTP library and a stale dependency with a known sandbox-escape vulnerability.
- The live event stream no longer responds to unauthenticated requests.
- Your session cookie is no longer forwarded to third-party printers through the camera/file proxy.

### Housekeeping

- Reproducible builds, content-hashed asset filenames, and an asset-manifest system (no more hardcoded bundle
  names).
- New smoke tests requiring no framework, database, or hardware: proxy behavior, cross-printer file transfer, and
  build/manifest verification.
- Working lint config (previously silently never ran) and a cleaned-up, drift-free dependency lockfile.
- Removed dead code (an old camera-snapshot path fully superseded by the streaming proxy) and the Patreon/supporter
  feature.
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

- [Gina Häußge](https://octoprint.org/) - without OctoPrint none of this, upstream or fork, would be possible.
- [OctoFarm](https://github.com/OctoFarm/OctoFarm) and its original maintainer - this fork exists on top of their
  work.

[DashboardScreenshot]: screenshots/dashboard.png
