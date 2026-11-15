![Status](https://img.shields.io/badge/status-maintained%20fork-brightgreen)
![License](https://img.shields.io/badge/license-AGPL--3.0-blue)
![Based on](https://img.shields.io/badge/based%20on-OctoFarm-9b59b6)

# OctoFarm-Redux

<div align="center">
  <img src="server/assets/images/navbar-logo.png" alt="OctoFarm-Redux logo" width="180px">

  <p align="center">
    OctoFarm-Redux is a personal fork of <a href="https://github.com/OctoFarm/OctoFarm">OctoFarm</a>, created by <a href="https://github.com/NotExpectedYet">James Mackay (NotExpectedYet)</a> and its contributors - a single pane of glass that combines multiple OctoPrint instances into one interface, monitoring and managing a 3D printer farm over the OctoPrint API and websocket systems.
  </p>

  <p align="center">
    <strong>Everything here rests on their work.</strong> The application, its architecture, and very nearly all of the
    code are theirs; they built it, and they gave it away for free under the AGPL. This fork only maintains what they
    made. Upstream OctoFarm is no longer being updated, so this repository keeps bugfixes and small improvements
    landing on top of it. It is not a successor or a community fork - just their work, kept running, and shared in case it is
    useful to anyone else.
  </p>
</div>

- [About](#about)
- [What's different from upstream](#whats-different-from-upstream)
- [Getting Started](#getting-started)
- [Installation](#installation)
- [Development setup](#development-setup)
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
- The temperatures a file was sliced with, shown beside its size: nozzle and bed, for the first layer and for the
  rest. OctoPrint's file list does not carry them and its own analysis does not look for them, but the slicer
  writes them into the file - so this reads the end of the gcode, where PrusaSlicer and OrcaSlicer append their
  configuration. The last 48KB of it, once per file ever, fetched after the list has already drawn, so a folder
  of two hundred files appears at once and fills in behind itself. Both slicers' spellings are read, so a file
  sliced in Orca's own dialect is understood as readily as a Prusa one, and a value the file does not carry shows
  as a dash rather than vanishing, so a half-known pair still says which half is missing. A file from a slicer
  that writes no configuration block (Cura stores its settings as a base64 blob) simply shows nothing.

**Torch** - turn a printer's light on and off from the command panel. A real toggle that reflects the light's
actual state, and it tells you when the light cannot come on because the printer's PSU is off, instead of
claiming success.

**Maintenance Mode** - suspends PSU Control's automatic power-off from the printer's command panel, so a printer
stays powered while you calibrate it, level the bed, or work on it, instead of the PSU cutting out on you
mid-task because the printer counts as idle. A farm-wide banner names every printer currently left that way, so
one does not sit powered up overnight because somebody forgot, and it appears the moment you toggle it rather
than on the next 30-second poll. Needs our companion OctoPrint plugin,
[Maintenance Mode (PSU Control)](https://github.com/KrisMakes/OctoPrint-MaintenanceMode), on each printer you
want it for, so it stays off until switched on under System > Server > Features.

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

**One connection per browser, not one per camera per tab** - the single largest change in this fork, and the
answer to the grey panes and the buttons that stop responding with nothing in the console to explain them.

A browser allows about six connections to one address over HTTP/1.1, shared across every tab, and anything that
streams holds one of them open for as long as it is on screen. Two cameras in two tabs is four of the six, plus
the event stream and the monitoring stream, and the budget is gone - and nothing fails cleanly when it does.
Every later request queues behind a stream that never ends, so the page renders with no printers on it and every
button stops working, with no error anywhere saying why. Measured in a tab that had run out: a `fetch()` had not
started after eight seconds, while a WebSocket opened in 42ms, because WebSockets are a separate pool.

So the number of connections stops following the number of viewers:

- The server opens one connection per camera however many people are watching, splits the multipart stream back
  into whole JPEGs and fans them out over a single WebSocket. Cameras nobody can see are not subscribed at all,
  and the printer's Pi serves one stream instead of one per pane. Frames are painted into the same `<img>`
  elements the templates already draw, so every CSS flip, aspect-ratio class and layout rule keeps working.
- The event stream and the monitoring stream moved onto that same socket, so a tab holds no permanent HTTP
  connection at all and tab count stops mattering. The HTTP endpoints are untouched and still serve the same
  payloads - this is a second way in, not a replacement, and a browser that cannot open the socket falls back to
  them unchanged.
- The socket lives in a SharedWorker, so there is one for the whole browser rather than one per tab. Each tab
  reaches it down a MessagePort, which costs no connection, and the worker keeps the union of what the tabs want:
  a camera is subscribed when the first tab asks for it and dropped when the last one stops, and a second tab
  showing the same camera costs nothing. This is what the budget actually ran out of in Safari, which counts
  WebSockets against it where Chrome does not.

The camera half is opt-in, under System > Server > Cameras > Multiplexer: the direct streams work, and this
changes how every camera on the farm is delivered, so an upgrade does not inherit it. Switching it off takes
effect immediately on every open tab rather than at the next reload.

**Raise the head after cancelling** - a cancelled print used to leave the nozzle parked over the plate, in the
way of whatever has to come off it. Cancelling now lifts it ten centimetres clear. The move is relative, so it
is ten centimetres from wherever the print stopped rather than a fixed height, and the firmware's soft limit
clips it at the top of the Z axis. It waits for the printer first - a cancel is not instant, and OctoPrint
refuses commands outright while a job is still running - and if it gives up waiting it says so, rather than
leaving the impression the head moved. Hooked into the job action rather than the buttons, so it covers every
way a print is cancelled: the panel card, the control modal and bulk actions alike.

**Cancel a single object mid-print** - when one part of a multi-object plate lifts or turns into spaghetti, cancel
just that one from the job modal and let the rest of the plate finish. The objects of the current file are listed
with a Cancel button each, the one being printed right now is marked, and cancelling asks first and says plainly
what it does and does not do - the rest carries on, but what is already printed stays on the bed and the nozzle
still travels over it.

Each object is described by where it sits *relative to the others* ("back left"), not by bed quadrant and not by
the name the slicer gave it. Four copies of one STL are all "front left" in absolute terms, and
"Part4.STL (Instance 2)" identifies nothing you can see while looking at a failed print.

Above the list is a top-down plan of the bed, with every object drawn where it actually prints, numbered to match
the list and clickable to cancel. The one printing now is highlighted and cancelled ones are dimmed. Bounds come
from the plugin, which learns them as each object prints, so the plan fills in over the first layer and anything
not yet known is left out rather than guessed at.

Goes through the Cancel Object OctoPrint plugin rather than sending `M486` directly, so it does not depend on the
printer's firmware understanding object cancellation - the plugin suppresses the extrusion host-side as the file
is streamed. The section is always present, and says why it is empty (file sliced without object labels, or the
plugin not installed on that printer) rather than disappearing.

**Everything else:**
- Corrected, actionable error messages when OctoPrint's own reported state contradicts itself (e.g. "already
  printing" while the printer shows disconnected), instead of a generic conflict message.
- Health check failures now name the specific check that failed (printer settings, required API, websocket,
  connection defaults, webcam settings, or history collection) instead of one generic "Failed health check!".
- A page under System that says what is actually connected: how many live sockets are open, what each has sent
  and dropped, what the camera hub is doing, and how many clients are still on the HTTP form of each stream -
  which is where a connection nobody closed shows up by name. Deliberately not administrator-only: this is what
  to look at when a tab will not load, and a browser that has run out of connections cannot open an administrator
  session to ask why.
- Replaced the toilet-roll filament icon with a real spool.

### Improvements

- Coming back to a tab no longer throws the whole page away and rebuilds it, which is why switching between open
  tabs used to feel slow. It used to, and that was right at the time: everything the page held across a switch
  away was a long-lived HTTP connection, WebKit abandons those when the window goes behind another application
  without reporting it, and a request queued behind an abandoned one never errors - it simply never happens,
  which is both the grey camera pane and the buttons that stop responding with no message. From inside the page an
  abandoned stream cannot be told apart from a healthy one, so there was nothing to check and discarding the lot
  was the only reliable cure. Carrying the streams and the cameras on one socket removed that premise: a socket,
  unlike a stream, can be asked whether it is still there, and it is asked on every return and rebuilt if nothing
  answers. The reload now runs only where the old reasoning still holds - the socket refused, an older server, or
  the multiplexer switched off - and there it behaves exactly as before: held back while a dialog is open or
  something is being typed, and coming back in the same scroll position.
- A tab left open across a deploy reloads itself once, instead of running the old build until somebody remembers
  to refresh it. Bundle names carry a content hash, so after a deploy a stale tab's files no longer exist - but
  nothing told the tab, and whatever bug it was built with carried on. Three tabs left open across a day of
  deploys were still holding one connection per camera, a whole browser's budget between them, a week after that
  limit had been removed. The id a page compares itself against covers every bundle rather than one of them:
  webpack splits the shared code out of the entries, and two deploys in a row once changed only that shared
  chunk, so the id never moved and neither fix reached the browser that had reported the bug. Once per build
  rather than once per page, so a tab picks up the next deploy too but can never loop.
- Camera frames are painted on the display's beat rather than the instant they arrive. A camera sends thirty
  frames a second, a screen redraws sixty times a second, and the two are not in step - handing the element each
  frame as it lands means the gap between one appearing and the next varies by however far its arrival fell from
  the next redraw. Chrome hides that; WebKit shows it as judder. Measured on the wire both browsers were being
  sent the same even thirty frames a second, so the server was never the thing at fault.
- How far behind a browser is, is now measured by the browser. Nothing on the server can see it: `bufferedAmount`
  counts only what is queued above the socket, and `send`'s callback fires when the kernel accepted the bytes,
  which it keeps doing until its own buffer is full - and Linux grows that into the megabytes. Both readings were
  blind to a steady 1-2MB backlog per viewer that never drained, which is about a second of latency on every
  camera, permanently. The browser now counts what it has received and says so a few times a second, the server
  counts what it has sent and not had acknowledged, and a viewer that falls behind has frames dropped rather than
  queued behind it.
- A page that loses its cameras writes down why. What the socket did, what each camera was told, how many frames
  each pane has drawn and how long since one arrived - saved every few seconds where a reload cannot take it with
  it, and sent by the next page to load. The reload that ends the broken state is therefore how the evidence
  arrives rather than the end of it, and a page that recovers on its own reports itself just as readily, so a
  case that heals is as visible as one that does not.
- Printer cards on the panel, camera and group views are sized by width rather than by a column count, so the
  number of columns follows the window and the printer count instead of a stored number that cannot know either.
  A column count is wrong on at least one screen the moment it is saved - six per row is comfortable on a large
  monitor and unreadable on a laptop - so the setting is now a card size (compact, default, large) that still
  means the same thing on any display. Replaces the separate Camera and Group column settings.
- Leaving the page hands every camera connection back, so a tab sitting behind another window no longer holds one
  per camera, and the pane keeps showing its last frame rather than going blank while it is away.
- A camera that dies while you are watching is recovered without any of the above, and one showing an unchanging
  picture (a dark enclosure overnight) is still not mistaken for a dead one and reconnected all night.
- Camera panes no longer leak a connection every time a printer card is redrawn. A discarded `<img>` keeps its
  stream open in WebKit - detaching it from the page does not end the response - so streams accumulated until the
  browser's per-site connection limit was gone, at which point the cameras went blank and no amount of
  reconnecting could help, because the reconnect could not get a connection either.
- A printer's camera only streams into its modal while that modal is open. Each printer used to hold a second
  live stream for a modal nobody had opened, which on a two-printer farm was four of the six connections a
  browser allows per site.
- Monitoring cards are sized by how wide they should be rather than by a fixed column count, so the panel and
  camera views fill the row properly at any window size.
- The camera aspect-ratio setting is applied to the camera views, instead of being saved and then ignored.
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
- The camera view spread its cards across the row with empty gaps between them - on a two-printer farm, one card
  at each end. An unclosed tag in the template left an empty element after every card, which counted as a column
  of its own once the monitoring views moved to a grid.
- A camera that was simply switched off was retried every fifteen seconds indefinitely. Ending a stream points
  the image at a blank pixel, which counts as a load, which was read as the camera coming back and reset the
  back-off each time it was applied.
- Quick Connect's state could stop syncing entirely if one button was missing from the page.
- The Torch and Maintenance Mode toggles could double-fire and flip straight back, or deadlock a button
  permanently.
- Spool cost was being silently under-reported on cancelled/failed prints (double-applied completion-ratio bug).
- Thumbnails could silently fail to save for any printer with API access control enabled.
- Gcode thumbnails never actually displayed. The URL was built straight at the printer, from the browser, and
  OctoPrint serves thumbnails behind its access control - so it answered 403, because the browser has no API key
  and deliberately is not given one. They now go through the same proxy as every other OctoPrint call, which adds
  the key server-side. Fixed in the job modal, the file manager, and both camera fallbacks.
- The job modal rendered a broken image for any file with no thumbnail at all: the check was `!== null`, and a
  job without one leaves the field `undefined`, which is not `null`.
- The job modal showed "NaN / NaN" for electricity, maintenance and printer-total costs. Those are only worked
  out when the matching options are enabled in server settings; with them off the figure never arrives and the
  display parsed `undefined`. It now says the cost was not calculated.
- The filament pre-flight check never fired, for any print, since it was written. It looked up `filamentLength`
  on the file record, but the server stores the per-tool lengths as `length`, so the lookup always came back
  empty and the check passed everything through without comparing anything. Found when a 189g print started
  against a spool holding 36.8g and said nothing.
- The spool Remaining column printed the full floating-point result of weight minus used -
  "36.811371464054105g". Used is accumulated from per-print filament lengths, so the subtraction lands on
  floating-point noise. It now shows whole grams, while the stored value keeps its precision so repeated small
  deductions still accumulate correctly.
- Camera streams rendered as empty boxes in Safari inside the card grid.
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
- Log and plugin-manager downloads produced a zero-byte or broken zip, and the Git-based version check threw on
  startup. Both were the same class of break: `archiver` and `simple-git` changed how they export their factory
  across a major version, so the old `require(...)` call silently produced something that was not a function.

### Security

- Closed a bypass where the registration page could be POSTed to directly and create an account even while
  registration was disabled in settings.
- The entire server-side template source tree used to be served as static files to anyone, logged in or not.
- Login and registration now have their own strict rate limit; previously the only limit in place was far too
  generous to stop password guessing.
- Removed a long-deprecated HTTP library and a stale dependency with a known sandbox-escape vulnerability.
- The live event stream no longer responds to unauthenticated requests.
- Your session cookie is no longer forwarded to third-party printers through the camera/file proxy.
- Every advisory `npm audit` reports against the server is resolved: thirteen down to none, ten of which were in
  the production tree. Where an upgrade existed it was taken; where a library pinned a vulnerable transitive
  dependency and upstream had gone quiet, that dependency is pinned to a patched version through an `overrides`
  entry; and `node-upnp-ssdp`, unmaintained since 2015, was dropped for a small built-in SSDP client that does
  only what printer auto-discovery actually needs.
- The client's bundled libraries went from thirty advisories to one. The remaining one is bootbox, and it has no
  fix: it renders dialog messages and titles as HTML by design, and upstream closed the report as out of scope,
  so there is no patched release to move to. Instead, every untrusted value that reaches a dialog - gcode file and
  folder paths, printer names, spool labels, strings relayed from an OctoPrint instance - is escaped at the call
  site, behind one shared helper that documents why.

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

This fork doesn't change how the application works day-to-day, only fixes and small additions on top. Upstream's
documentation site (`docs.octofarm.net`) is offline and its domain has lapsed, so what remains of the original
documentation lives in [the original repository](https://github.com/OctoFarm/OctoFarm). Everything specific to this
fork is in this README.

## Installation

### Unraid

The Unraid template is in this repository at [`templates/octofarm-redux.xml`](templates/octofarm-redux.xml) and is
submitted to Community Applications, so the normal route is to search for **OctoFarm-Redux** in the **Apps** tab and
install it from there. The image bundles MongoDB, so there is no second container to add.

Two fields matter on first install:

- **Session key** (`SUPER_SECRET_KEY`) - paste a long random string. The container generates one when it is left
  empty, which logs every user out each time the container is recreated.
- **Database config** (`/data/configdb`) - leave the mapping in place. The `mongo` base image declares that path
  as a volume, so removing it strands an anonymous volume on every redeploy.

Open the web interface afterwards and register the first account; it becomes the administrator.

Coming from an existing OctoFarm install, point **Thumbnails** and **Scripts** at the old `images` and `scripts`
folders and they carry over unchanged. The database does not: this image runs its own `mongod` against `/data/db`,
so the old MongoDB container's contents have to be moved across with `mongodump` and `mongorestore`.

### Docker

Released images are published to GitHub Container Registry as `linux/amd64`:

```sh
docker run -d --name octofarm-redux --restart unless-stopped \
  -p 4000:4000 \
  -e SUPER_SECRET_KEY='a long random string' \
  -e TZ=Europe/London \
  -v /path/to/appdata/db:/data/db \
  -v /path/to/appdata/configdb:/data/configdb \
  -v /path/to/appdata/images:/app/images \
  -v /path/to/appdata/logs:/app/logs \
  -v /path/to/appdata/scripts:/scripts \
  ghcr.io/krismakes/octofarm-redux:latest
```

Remove the container with `docker rm -v` so its anonymous volumes go with it.

## Development setup

### Requirements
- Git
- Node.js >= 20.19.0 (the Docker image and CI both use Node 24)
- npm

1. Clone the repo

```sh
git clone https://github.com/KrisMakes/OctoFarm-Redux.git
```

2. Install the mono-repo eslint dependencies (eslint, prettier and nodemon)

```sh
npm install
```

3. Install server and client dependencies

```sh
npm run setup-dev
```

4. Create an `.env` file in the project root, e.g. `OctoFarm-Redux/.env`. Every
   setting is documented in [`.env.example`](.env.example), and every one has a
   default, so copying it unedited is enough to start:

```sh
cp .env.example .env
```

   The minimum, if you would rather write it yourself:

```dotenv
NODE_ENV=development
MONGO=mongodb://127.0.0.1:27017/octofarm
OCTOFARM_PORT=4000
```

5. Build the latest client
```sh
npm run build
```

6. (Optional) Watch for client changes, requires a secondary console.
```sh
npm run dev-client
```

7. Start the server

```sh
npm run dev-server
```
- The developer version uses nodemon for live server reloading on changes, and outputs all logs to the console.

## Deployment

Released images are built from `monolithic.Dockerfile` by
[`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml), which runs on a `v*` tag, pushes
`ghcr.io/krismakes/octofarm-redux`, and fails the release if the image it just pushed does not come up healthy. The
same image builds locally, and bundles MongoDB, so there is nothing else to deploy alongside it:

```sh
docker build -f monolithic.Dockerfile -t octofarm-redux:local .
```

Two things to get right when redeploying, both easy to miss:

- The base image is `mongo:8.0`, which declares **both** `/data/db` and `/data/configdb` as volumes. Map only
  `/data/db` and Docker invents an anonymous volume for `/data/configdb`; remove the old container without `-v`
  and that volume is stranded, every single deploy. Map both paths, and remove with `docker rm -v`.
- Pass `SUPER_SECRET_KEY` in explicitly. The container generates one when it is missing, so letting it do that
  on each deploy invalidates every session and logs everyone out.

Client-side changes need a client rebuild (`cd client && npm run build`) before committing - the prebuilt webpack
output is committed under `server/assets/`, and a client-only edit without a rebuild ships stale JS.

## License

This work [is licensed](LICENSE) under the [GNU Affero General Public License v3](https://www.gnu.org/licenses/agpl-3.0.html).

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
**[the original project](https://github.com/OctoFarm/OctoFarm)** first. This fork makes no claim to be its
continuation. Note that upstream's website and documentation domains have lapsed - `octofarm.net` and
`docs.octofarm.net` no longer resolve to the project - so the repository itself is all that is left of it.

Like upstream, this fork stays under the same [AGPL-3.0 licence](LICENSE) it was given under.

## Support

OctoFarm-Redux is free. If the work in this fork - the fixes and additions listed above - has been useful to you,
you can leave a tip at [ko-fi.com/krismakes](https://ko-fi.com/krismakes). Entirely optional; nothing is locked behind
it.

[DashboardScreenshot]: screenshots/dashboard.png
