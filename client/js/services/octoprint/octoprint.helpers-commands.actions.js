import UI from '../../utils/ui';

// OctoPrint can say "already printing" while its own /api/connection and
// /api/job report the serial link closed and no job running -- confirmed
// 2026-09-14 by calling OctoPrint directly, bypassing OctoFarm entirely. This
// is OctoPrint's internal "currently printing" flag surviving an unexpected
// disconnect mid-print rather than being cleared by a normal job end, and it
// will not resolve on its own. Passing the raw text on in that state sends
// someone looking at an idle-looking printer for a print that isn't there.
const ALREADY_PRINTING_PATTERN = /already printing/i;

/**
 * OctoPrint's own explanation for a failed request, corrected against what
 * OctoFarm's own websocket connection to the printer currently shows.
 *
 * 409 does not mean one thing. OctoPrint returns it when the printer is not
 * operational, when a file is being printed, and when the destination already
 * exists -- and it says which in the response body as {"error": "..."}. We used
 * to report every one of them as "file is in use", which sends people looking
 * for a lock on a file when the actual answer is that the printer's serial
 * connection is closed.
 *
 * @param response the failed fetch Response (or the Error OctoPrintClient
 *   hands back when the request itself failed)
 * @param fallback shown if the body carries no {error} at all
 * @param printer optional -- when given, its current printerState is used to
 *   catch OctoPrint contradicting itself (see ALREADY_PRINTING_PATTERN above)
 */
export const readOctoPrintError = async (response, fallback, printer) => {
  let reason = fallback;
  try {
    // clone() so a caller that goes on to read the body itself still can.
    const body = await response.clone().json();
    if (body?.error) {
      reason = body.error;
    }
  } catch (e) {
    // Not JSON, body already consumed, or `response` is the Error that
    // OctoPrintClient hands back when the fetch itself failed.
  }

  const category = printer?.printerState?.colour?.category;
  if (ALREADY_PRINTING_PATTERN.test(reason) && category && category !== 'Active') {
    const name = printer.printerName ?? 'This printer';
    const state = printer.printerState.state;
    return (
      `OctoPrint thinks a print is already running, but ${name} is showing as ` +
      `"${state}" right now. This usually means OctoPrint's connection to the ` +
      `printer dropped mid-print and it never cleared that flag -- try ` +
      `disconnecting and reconnecting the printer to clear it.`
    );
  }
  return reason;
};

export const fileActionStatusResponse = (status, item, action, actionPastTense) => {
  if (status === 204 || status === 200) {
    UI.createAlert('error', `We could not find the ${item}, does it exist?`, 3000, 'clicked');
  } else if (status === 409) {
    UI.createAlert(
      'warning',
      `There was a conflict, ${item} already exists or is in use...`,
      3000,
      'clicked'
    );
  } else {
    UI.createAlert('success', `Successfully ${actionPastTense} your ${item}...`, 3000, 'clicked');
  }
};
export const printActionStatusResponse = (status, action) => {
  if (status === 204 || status === 200 || status === 201) {
    UI.createAlert('success', `Your ${action} command was successful`, 3000, 'clicked');
  } else if (status === 409) {
    UI.createAlert(
      'warning',
      `There was a conflict, could not complete the ${action} command.`,
      3000,
      'clicked'
    );
  } else {
    UI.createAlert('error', `There was an error with your ${action} command`, 3000, 'clicked');
  }
};
