import UI from '../../utils/ui';

/**
 * OctoPrint's own explanation for a failed request.
 *
 * 409 does not mean one thing. OctoPrint returns it when the printer is not
 * operational, when a file is being printed, and when the destination already
 * exists -- and it says which in the response body as {"error": "..."}. We used
 * to report every one of them as "file is in use", which sends people looking
 * for a lock on a file when the actual answer is that the printer's serial
 * connection is closed.
 */
export const readOctoPrintError = async (response, fallback) => {
  try {
    // clone() so a caller that goes on to read the body itself still can.
    const body = await response.clone().json();
    if (body?.error) {
      return body.error;
    }
  } catch (e) {
    // Not JSON, body already consumed, or `response` is the Error that
    // OctoPrintClient hands back when the fetch itself failed.
  }
  return fallback;
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
