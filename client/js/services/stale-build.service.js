// Reloads a page that is running code which is no longer deployed.
//
// An open tab keeps running the JavaScript it loaded. Bundle names carry a
// content hash, so after a deploy the files a stale tab was built from are
// gone -- but the tab does not know that, and nothing makes it find out. It
// carries on, and whatever bug it was built with carries on with it.
//
// That is not cosmetic. During this work three tabs left open across a day of
// deploys were still running a build whose cameras used one HTTP connection
// each: six connections between them, a whole browser's budget, so no further
// tab would load at all. The fix for each round of that was "reload", which is
// a poor thing to need and an easy thing to forget -- and every further deploy
// put them back.
//
// The live socket says which build is deployed. A page whose own bundle name
// differs reloads, once.
const SETTLE_AFTER_LOAD_MS = 5000;

// Remembered per build rather than as a flag, so a page can reload again for
// the NEXT deploy but never twice for the same one. A reload loop would be far
// worse than running a stale page.
const RELOADED_FOR = 'octofarm-reloaded-for-build';

// What this page is running: the name it was actually served, which is the one
// thing a stale page still knows the truth about.
const ownBuild = () => {
  const script = document.querySelector('script[src*="events.service"]');
  const src = script?.getAttribute('src') || '';
  return src.split('/').pop() || null;
};

const alreadyReloadedFor = (build) => {
  try {
    return sessionStorage.getItem(RELOADED_FOR) === build;
  } catch (e) {
    // Private browsing, or storage refused. Treat it as "yes" and leave the
    // page alone: a stale page is better than one that might reload forever.
    return true;
  }
};

const rememberReloadFor = (build) => {
  try {
    sessionStorage.setItem(RELOADED_FOR, build);
    return true;
  } catch (e) {
    return false;
  }
};

const loadedAt = Date.now();

/**
 * @param deployedBuild what the server says is current, or null from a server
 *                      too old to say -- in which case nothing happens, which
 *                      is the same as before this existed.
 */
export const checkBuild = (deployedBuild) => {
  if (!deployedBuild) {
    return false;
  }
  const mine = ownBuild();
  // A page that cannot tell what it is running must not guess.
  if (!mine || mine === deployedBuild) {
    return false;
  }
  if (alreadyReloadedFor(deployedBuild)) {
    return false;
  }
  // Not in the first moments of a page's life: a reload decided while the page
  // is still settling is the shape a loop starts with.
  if (Date.now() - loadedAt < SETTLE_AFTER_LOAD_MS) {
    return false;
  }
  // Someone part-way through something loses it on a reload. They will get the
  // new build on their next visit, which is soon enough.
  if (document.querySelector('.modal.show')) {
    return false;
  }
  const active = document.activeElement;
  if (active && (active.matches('input, textarea, select') || active.isContentEditable)) {
    return false;
  }
  if (!rememberReloadFor(deployedBuild)) {
    return false;
  }
  console.debug(`This page is running ${mine}, the server has ${deployedBuild} -- reloading`);
  window.location.reload();
  return true;
};
