// Reloads the page when you come back to it after being somewhere else.
//
// Everything this page holds across a switch away is a long-lived connection:
// the event stream, the monitoring worker's stream, and one per camera. A
// browser allows about six to one origin and shares them across tabs, and
// WebKit abandons them when the window goes behind another application without
// ever reporting it. Rebuilding them by hand has been tried from every angle --
// detect the dead ones, reconnect all of them, release them on the way out and
// retake them one at a time -- and each version fixed the case it was written
// for and left another one dead, because a stream that has been abandoned is
// indistinguishable from a healthy one from inside the page, and a request that
// is queued behind one never errors, it simply never happens. That is both the
// grey camera and the buttons that stop responding with no message.
//
// A reload has none of that uncertainty. Every connection is torn down and
// built again from nothing, which is exactly what reaching for the refresh
// button was doing. It costs a second and the page comes back in the same
// scroll position.
//
// It is held back in the few places where throwing the page away would throw
// work away with it -- see shouldHoldOff.

import { recoverCamerasNow } from './camera-stream-watchdog.service';

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
  if (reloadNow()) {
    return;
  }
  // Not reloading, so the camera streams released on the way out are still
  // released and nothing else is going to take them back.
  recoverCamerasNow();
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
