// Reloads the page when you come back to it after being somewhere else, in the
// cases where that is still the only way to put it right.
//
// This was written when everything the page held across a switch away was a
// long-lived HTTP connection: the event stream, the monitoring worker's stream,
// and one per camera. A browser allows about six to one origin and shares them
// across tabs, and WebKit abandons them when the window goes behind another
// application without ever reporting it. Rebuilding them by hand was tried from
// every angle -- detect the dead ones, reconnect all of them, release them on
// the way out and retake them one at a time -- and each version fixed the case
// it was written for and left another one dead, because a stream that has been
// abandoned is indistinguishable from a healthy one from inside the page, and a
// request queued behind one never errors, it simply never happens. That is both
// the grey camera and the buttons that stop responding with no message. A
// reload had none of that uncertainty, because it threw every connection away.
//
// The live socket removed the premise. A page carrying its streams and its
// cameras on the socket holds no long-lived HTTP connection at all, and unlike
// a stream a socket can be asked whether it is still there: live-socket's own
// return handler pings it and rebuilds it if nothing answers. So in that case
// there is nothing for a reload to fix, and reloading is not free -- it is a
// second of blank page and a full rebuild on every single tab switch, which is
// what switching between tabs being slow actually was.
//
// Where the socket is not carrying everything -- it was refused, the server is
// older, the camera multiplexer is switched off -- the old HTTP streams are
// back, and so is the reload, because the reasoning above is unchanged for
// them.
//
// It is also held back in the few places where throwing the page away would
// throw work away with it -- see shouldHoldOff.

import { recoverCamerasNow } from './camera-stream-watchdog.service';
import { isSocketUp, socketCarries, socketFeature } from './live-socket.service';

// Whether this page is holding anything a reload would be the only cure for.
// All three have to hold: the socket has to be up, it has to be carrying the
// event stream this page would otherwise have opened itself, and the cameras
// have to be on it rather than on an MJPEG stream each. The monitoring worker
// needs no condition -- it is terminated when the page is hidden and built
// again on return, so it is never the stale one.
const holdsNoAbandonableStreams = () =>
  isSocketUp() && socketCarries('/events') && socketFeature('enabled') === true;

// A reload loop would be far worse than the bug, so returns that arrive in
// quick succession reload once.
const MIN_RELOAD_INTERVAL_MS = 5000;

// Nothing reloads in the first moments of a page's life. Without this a focus
// event that arrives as the page is still settling can reload it immediately,
// and then again, and again.
const SETTLE_AFTER_LOAD_MS = 3000;

const loadedAt = Date.now();
let lastReloadRequestAt = 0;

// True while the page is showing something the user would lose. A reload is
// skipped outright rather than deferred: the next switch away and back will
// pick it up, and by then whatever this was protecting is finished.
const shouldHoldOff = () => {
  // An open dialog is someone part-way through something -- editing a printer,
  // picking files, reading a job's details.
  if (document.querySelector('.modal.show')) {
    return true;
  }
  // Typing anywhere, including the filter and search boxes that are not in a
  // dialog at all.
  const active = document.activeElement;
  if (active && (active.matches('input, textarea, select') || active.isContentEditable)) {
    return true;
  }
  return false;
};

// Returns whether it reloaded, so the caller knows whether anything still has
// to be put right by hand.
const reloadNow = () => {
  const now = Date.now();
  if (now - loadedAt < SETTLE_AFTER_LOAD_MS) {
    return false;
  }
  if (now - lastReloadRequestAt < MIN_RELOAD_INTERVAL_MS) {
    return false;
  }
  if (shouldHoldOff()) {
    return false;
  }
  lastReloadRequestAt = now;
  window.location.reload();
  return true;
};

// Both events describing one departure set this, and either half of the return
// clears it, so a return is acted on exactly once however it is reported. It
// also means a focus that follows no departure -- clicking back into a window
// that never went anywhere -- does nothing, with no timing involved.
let away = false;

const markAway = () => {
  away = true;
};

const markBack = () => {
  if (!away) {
    return;
  }
  away = false;
  if (!holdsNoAbandonableStreams() && reloadNow()) {
    return;
  }
  // Either nothing needed reloading, or a reload was held back. A camera
  // pointed straight at its printer is still an MJPEG stream whatever the
  // socket is carrying, and this is what takes those back -- it skips anything
  // the multiplexer owns.

  recoverCamerasNow();
};

// How long between reloads this page asks for on its own. Across reloads, so
// it has to outlive the page: a page that reloads itself and comes back just as
// broken must not do it again a few seconds later, and the counter that would
// have stopped it is gone with the page that set it.
const MIN_BETWEEN_ASKED_RELOADS_MS = 5 * 60 * 1000;
const ASKED_RELOAD_KEY = 'octofarm-asked-reload-at';

const lastAskedReloadAt = () => {
  try {
    return Number(window.localStorage.getItem(ASKED_RELOAD_KEY)) || 0;
  } catch (e) {
    // No storage, so no way to tell whether this has just happened. Treated as
    // if it had: a reload loop is far worse than a pane left grey.
    return Date.now();
  }
};

/**
 * Reloads the page because the caller has run out of other ways to put it
 * right, if it is safe to throw this page away.
 *
 * The last resort behind everything else, and deliberately the same remedy the
 * person was reaching for anyway -- the complaint being answered is "the
 * cameras stop until I reload". Doing it for them is worth little in itself;
 * what makes it acceptable is that the page sends its diagnostic trail first,
 * so a reload is also how the fault gets reported rather than hidden.
 *
 * @returns whether it is reloading
 */
export const reloadBecause = (reason) => {
  const now = Date.now();
  if (now - loadedAt < SETTLE_AFTER_LOAD_MS) {
    return false;
  }
  if (now - lastAskedReloadAt() < MIN_BETWEEN_ASKED_RELOADS_MS) {
    return false;
  }
  if (shouldHoldOff()) {
    return false;
  }
  try {
    window.localStorage.setItem(ASKED_RELOAD_KEY, String(now));
  } catch (e) {
    return false;
  }
  console.debug(`Reloading: ${reason}`);
  window.location.reload();
  return true;
};

export const startReloadOnReturn = () => {
  // A tab switch, and anything else that hides the page.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      markBack();
    } else {
      markAway();
    }
  });

  // Switching to another application, which is not a visibility change: on
  // macOS a tab behind another app is still the frontmost tab of a visible
  // window, so visibilityState stays 'visible' and the event above never fires.
  // Only window focus sees that, and it is the case the panes are actually
  // found grey in.
  window.addEventListener('blur', markAway);
  window.addEventListener('focus', markBack);
};
