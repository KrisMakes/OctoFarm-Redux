import OctoFarmClient from './octofarm-client.service';
import { spoolNumberLabel } from '../pages/filament-manager/filament-manager.templates';
import { escapeHtml } from '../utils/html.utils';

// Warns before a print starts when the spool assigned to that tool may not
// have enough filament left to finish it.
//
// Deliberately narrow. It only speaks up when there IS a spool assigned -- an
// unassigned tool is not something this has an opinion about -- and it only
// ever warns. Both numbers it works from are estimates: the length comes from
// the slicer's own analysis, and what is left on the spool is only as good as
// the downdating that has happened since it was weighed. Something that
// refused to print on that basis would be wrong often enough to be turned off,
// and then it would warn about nothing at all.

// Same defaults the server falls back to for a spool with no profile.
const DEFAULT_DIAMETER_MM = 1.75;
const DEFAULT_DENSITY = 1.24;

// Above the needed amount by less than this counts as "cutting it fine".
const TIGHT_MARGIN = 0.05;

// The settings are read per print start, so they are cached briefly rather than
// fetched on every click of a bulk action.
const SETTINGS_TTL_MS = 30000;
let cachedSettings = { readAt: 0, enabled: false };

/**
 * Grams of filament a length of strand from this spool weighs.
 * @param lengthInMillimetres as OctoPrint reports it in the gcode analysis
 * @param spool the assigned spool, or null for generic 1.75mm PLA
 * @returns {number|null} null when there is no usable length to work from
 */
export const gramsForLength = (lengthInMillimetres, spool) => {
  const metres = parseFloat(lengthInMillimetres) / 1000;
  if (!Number.isFinite(metres) || metres <= 0) {
    return null;
  }
  const diameter = parseFloat(spool?.spools?.profile?.diameter);
  const density = parseFloat(spool?.spools?.profile?.density);
  const radius = (Number.isFinite(diameter) && diameter > 0 ? diameter : DEFAULT_DIAMETER_MM) / 2;
  const volume = metres * Math.PI * radius * radius;
  return volume * (Number.isFinite(density) && density > 0 ? density : DEFAULT_DENSITY);
};

/**
 * Grams still on a spool, or null when the spool has no usable weight -- an
 * unweighed spool cannot run short of anything.
 */
export const gramsRemaining = (spool) => {
  const weight = parseFloat(spool?.spools?.weight);
  if (!Number.isFinite(weight) || weight <= 0) {
    return null;
  }
  const used = parseFloat(spool?.spools?.used);
  return weight - (Number.isFinite(used) ? used : 0);
};

const spoolLabel = (spool) => {
  const label = [spoolNumberLabel(spool?.spools?.spoolNumber), spool?.spools?.name]
    .filter(Boolean)
    .join(' ');
  return label.length ? label : 'the assigned spool';
};

/**
 * The per-tool filament lengths for a file already on the printer, or null
 * when we have no analysis to go on -- a freshly uploaded file OctoPrint has
 * not finished reading yet, most often. Nothing to compare means nothing to
 * say, so the caller stays quiet.
 */
export const lengthsForFile = (printer, fullPath) => {
  const file = printer?.fileList?.fileList?.find((entry) => entry.fullPath === fullPath);
  // `filamentLength`, not `length`. OctoPrint's own file record does call this
  // `length`, and create-octoprint.service.js builds it from
  // gcodeAnalysis.filament[tool].length -- but that raw record is not what
  // reaches the client. file-cleaner.service.js renames the field on the way
  // out (`filamentLength: file?.length || 0`) and the cleaned record is what
  // the printer store serves, so `length` is simply absent here.
  //
  // Reading `length` therefore matched nothing on every file, lengthsForFile
  // returned null every time, and confirmEnoughFilament short-circuited to
  // "fine" before comparing anything -- so the gate was silently dead from
  // a09e58a6 until this. Verified against a live record on 2026-11-08:
  //   filamentLength: [10221.537540001562]   length: undefined
  // taken from the same printerInfo payload whose server-side filamentWarning
  // already read "has -3527.6g left, this needs 30.5g". The server saw it; only
  // the dialog could not.
  //
  // Absent analysis is `0` rather than an array (see file-cleaner above), which
  // the Array.isArray guard below turns back into null -- a file OctoPrint has
  // not finished reading yet is still something this says nothing about.
  const lengths = file?.filamentLength;
  return Array.isArray(lengths) && lengths.length ? lengths : null;
};

/** The same, for whichever file is currently loaded on the printer. */
export const lengthsForCurrentJob = (printer) => {
  const filePath = printer?.currentJob?.filePath;
  if (!filePath || filePath === 'No File Selected') {
    return null;
  }
  return lengthsForFile(printer, filePath);
};

/**
 * Every tool whose assigned spool is short or close to it. An empty array
 * means there is nothing worth interrupting the user for.
 */
export const checkJobAgainstSpools = (printer, lengths) => {
  const warnings = [];
  if (!Array.isArray(lengths) || !Array.isArray(printer?.selectedFilament)) {
    return warnings;
  }

  lengths.forEach((length, tool) => {
    const spool = printer.selectedFilament[tool];
    if (!spool) {
      // No spool on this tool. Not this check's business.
      return;
    }
    const needed = gramsForLength(length, spool);
    const remaining = gramsRemaining(spool);
    if (needed === null || remaining === null) {
      return;
    }
    if (remaining >= needed * (1 + TIGHT_MARGIN)) {
      return;
    }
    warnings.push({
      tool,
      needed,
      remaining,
      shortfall: needed - remaining,
      short: remaining < needed,
      spoolLabel: spoolLabel(spool),
      printerName: printer.printerName,
    });
  });

  return warnings;
};

const isEnabled = async () => {
  if (Date.now() - cachedSettings.readAt < SETTINGS_TTL_MS) {
    return cachedSettings.enabled;
  }
  try {
    const settings = await OctoFarmClient.get('settings/server/get');
    // Absent means an older database that predates the setting; on is the
    // default there too.
    cachedSettings = { readAt: Date.now(), enabled: settings?.filament?.preflightCheck !== false };
  } catch (e) {
    // If the settings cannot be read, say nothing rather than guess. Getting
    // in the way of a print because a fetch failed would be the worse bug.
    cachedSettings = { readAt: Date.now(), enabled: false };
  }
  return cachedSettings.enabled;
};

const grams = (value) => `${value.toFixed(1)}g`;

const describe = (warning, withPrinterName) => {
  const who = withPrinterName ? `<b>${escapeHtml(warning.printerName)}</b> &mdash; ` : '';
  const tool = warning.tool > 0 ? ` (tool ${warning.tool})` : '';
  if (warning.short) {
    return `${who}${escapeHtml(warning.spoolLabel)}${tool} has ${grams(
      warning.remaining
    )} left, this print needs ${grams(warning.needed)} &mdash; about ${grams(
      warning.shortfall
    )} short.`;
  }
  return `${who}${escapeHtml(warning.spoolLabel)}${tool} has ${grams(
    warning.remaining
  )} left, this print needs ${grams(warning.needed)}. That is cutting it fine.`;
};

const askToContinue = (message) =>
  new Promise((resolve) => {
    bootbox.confirm({
      title: 'Not much filament left',
      message: `${message}<br><br>Print anyway?`,
      buttons: {
        confirm: { label: 'Print anyway', className: 'btn-warning' },
        cancel: { label: "Don't print", className: 'btn-secondary' },
      },
      callback: (result) => resolve(!!result),
    });
  });

/**
 * Gate a single print. Resolves true when the print should go ahead, which is
 * the answer in every case except the user choosing not to.
 */
export const confirmEnoughFilament = async (printer, lengths) => {
  if (!lengths || !(await isEnabled())) {
    return true;
  }
  const warnings = checkJobAgainstSpools(printer, lengths);
  if (warnings.length === 0) {
    return true;
  }
  return askToContinue(warnings.map((warning) => describe(warning, false)).join('<br>'));
};

/**
 * Gate a batch of prints. One dialog listing every printer that is short,
 * rather than one interruption per printer.
 * @param jobs [{ printer, lengths }]
 */
export const confirmEnoughFilamentForPrinters = async (jobs) => {
  if (!(await isEnabled())) {
    return true;
  }
  const warnings = [];
  for (const job of jobs) {
    if (!job?.lengths) {
      continue;
    }
    warnings.push(...checkJobAgainstSpools(job.printer, job.lengths));
  }
  if (warnings.length === 0) {
    return true;
  }
  return askToContinue(warnings.map((warning) => describe(warning, true)).join('<br>'));
};
