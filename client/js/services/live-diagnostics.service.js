// What a page was doing before someone gave up on it and reloaded.
//
// Five rounds of grey cameras have now been fixed by reasoning from the code to
// a plausible failure, reproducing that failure, and fixing it -- and the panes
// still stop. Every one of those was real and none of them was this. The thing
// missing is not another theory, it is the evidence: nothing survives the reload
// that ends the broken state, so the one moment worth looking at is the only one
// never recorded.
//
// So the page keeps a trail of what happened to it -- what the socket did, what
// each camera was told and when it last painted -- writes it where a reload
// cannot take it with it, and the next page to load sends it to the server. A
// reload is therefore no longer the end of the evidence, it is how the evidence
// arrives.
//
// It is also sent when the cameras recover by themselves, so a case that heals
// is reported as readily as one that does not. The two are told apart by what
// is in the trail, not by whether anyone was annoyed enough to reload.
//
// Costs: a few dozen small objects and one localStorage write every five
// seconds. Nothing here may throw into its callers, and nothing here may be
// required for anything to work -- a page whose diagnostics fail entirely must
// behave exactly as it did before this existed.

const TRAIL_KEY = 'octofarm-live-trail';
const MAX_EVENTS = 60;
const MAX_SAMPLES = 40;
const SAMPLE_EVERY_MS = 5000;

// A trail older than this describes a session nobody is asking about any more.
const TRAIL_STALE_AFTER_MS = 30 * 60 * 1000;

// Not oftener than this, whatever happens, so a page that is going wrong over
// and over cannot turn itself into a traffic generator.
const MIN_BETWEEN_SENDS_MS = 60000;

const startedAt = Date.now();
const events = [];
const samples = [];
let snapshotProvider = null;
let lastSentAt = 0;
let sampleTimer = null;

const pageId = Math.random().toString(36).slice(2, 8);

const safely = (fn, fallback) => {
  try {
    return fn();
  } catch (e) {
    return fallback;
  }
};

/**
 * Records something that happened. `what` is a short stable word -- it is read
 * in a log by a person, and grepped -- and `detail` is whatever makes it
 * meaningful.
 */
export const note = (what, detail) => {
  events.push({ at: Date.now() - startedAt, what, ...(detail || {}) });
  if (events.length > MAX_EVENTS) {
    // The oldest go first. What matters is the minutes before the page was
    // given up on, not the first moments of its life.
    events.splice(0, events.length - MAX_EVENTS);
  }
};

/**
 * Registers who can say what state the cameras are in. Kept as a callback so
 * this file knows nothing about cameras, sockets or views, and so a page
 * without any of them still records the rest.
 */
export const provideDiagnosticSnapshot = (fn) => {
  snapshotProvider = fn;
};

const ownBuild = () =>
  safely(() => {
    const script = document.querySelector('script[src*="events.service"]');
    return (script?.getAttribute('src') || '').split('/').pop() || null;
  }, null);

const trail = () => ({
  page: pageId,
  build: ownBuild(),
  // Which browser, because the failures here have been WebKit-specific and the
  // reports come from one browser while the testing happens in another.
  agent: safely(() => navigator.userAgent, null),
  href: safely(() => window.location.pathname, null),
  openedAt: startedAt,
  writtenAt: Date.now(),
  aliveForMs: Date.now() - startedAt,
  events: [...events],
  samples: [...samples],
});

const remember = () => {
  safely(() => window.localStorage.setItem(TRAIL_KEY, JSON.stringify(trail())));
};

const forget = () => {
  safely(() => window.localStorage.removeItem(TRAIL_KEY));
};

const send = (body, why) => {
  safely(() => {
    const payload = JSON.stringify({ why, trail: body });
    // keepalive, because the interesting case is a page being thrown away: an
    // ordinary fetch is cancelled by the navigation that caused it.
    window.fetch('/settings/system/liveDiagnostics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    });
  });
};

/**
 * Sends this page's trail now. Used when something has just been decided that
 * is worth seeing whether or not anyone reloads -- a connection rebuilt, a
 * camera starved and recovered.
 */
export const sendDiagnosticTrail = (why) => {
  const now = Date.now();
  if (now - lastSentAt < MIN_BETWEEN_SENDS_MS) {
    return;
  }
  lastSentAt = now;
  send(trail(), why);
};

// The trail the last page left behind, which is the one worth having: it ends
// at the moment someone decided the page was broken.
const sendPreviousTrail = () => {
  const saved = safely(() => window.localStorage.getItem(TRAIL_KEY), null);
  if (!saved) {
    return;
  }
  forget();
  const parsed = safely(() => JSON.parse(saved), null);
  if (!parsed || typeof parsed !== 'object') {
    return;
  }
  if (!parsed.writtenAt || Date.now() - parsed.writtenAt > TRAIL_STALE_AFTER_MS) {
    return;
  }
  // Marked as the page before this one, so nothing reading the log has to work
  // out which session it is looking at.
  send(parsed, 'previous-page');
};

const takeSample = () => {
  const snapshot = safely(() => snapshotProvider?.(), null);
  if (!snapshot) {
    return;
  }
  samples.push({ at: Date.now() - startedAt, ...snapshot });
  if (samples.length > MAX_SAMPLES) {
    samples.splice(0, samples.length - MAX_SAMPLES);
  }
  remember();
};

export const startLiveDiagnostics = () => {
  if (sampleTimer !== null) {
    return;
  }
  note('page-opened', { visible: safely(() => document.visibilityState, null) });
  sampleTimer = setInterval(takeSample, SAMPLE_EVERY_MS);
  // Last chance to write it down. The periodic write above is what actually
  // covers a page that is killed without warning, so this only has to catch
  // the last few seconds.
  window.addEventListener('pagehide', () => {
    note('page-leaving', { visible: safely(() => document.visibilityState, null) });
    remember();
  });
  // Deliberately after the first paint rather than on load: a page that has
  // just been reloaded by hand has something more urgent to do first.
  setTimeout(sendPreviousTrail, 4000);
};
