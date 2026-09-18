import PrinterPowerService from './printer-power.service.js';
import UI from '../utils/ui';
import OctoFarmClient from './octofarm-client.service';
import bulkActionsStates from '../pages/printer-manager/bulk-actions.constants';
import {
  printerIsDisconnectedOrError,
  printerIsIdle,
  printerIsOnline,
  printerIsPrinting,
} from '../utils/octofarm.utils';
import {
  printerEmergencyStop,
  printerHomeAllAxis,
  printerTurnOffHeaters,
  printerTorchToggle,
  printerMaintenanceModeToggle,
} from './octoprint/octoprint-printer-commands.actions';
import {
  connectPrinterSequence,
  disconnectPrinterSequenceNoConfirm,
} from './octoprint/octoprint-helpers.service';

// The WS281x LED strip on this farm is wired off the printer's own PSU rail,
// not the Pi's supply, so OctoPrint (running on the Pi) stays reachable and
// happily reports torch_on succeeding even with the PSU switched off -- the
// command lands, there's just no power at the strip to act on it. Check the
// smart-plug-reported power state first (when this printer has one
// configured) so the button says so instead of falsely claiming success.
// checkQuickConnectState/checkGroupQuickConnectState run on every printer
// state tick (~1s) and unconditionally reset these buttons' `disabled`
// attribute based on online/offline, which silently un-does the click
// handler's own `e.target.disabled = true` guard while a toggle is still in
// flight. A read-then-decide toggle (torch, maintenance mode) is exactly the
// case where a second click landing mid-flight matters: it re-reads a state
// that's about to change (or just changed) and immediately reverses the
// first click's effect, e.g. torch flipping on then straight back off. Track
// in-flight toggles independently of the DOM so an unrelated tick can't
// re-open this window.
//
// That independence cuts both ways, though: the old `disabled`-attribute
// guard got silently reset every ~1s regardless of whether the in-flight
// request ever actually finished, which accidentally self-healed a request
// that never settles. Safari can suspend a fetch indefinitely on a
// backgrounded tab without ever rejecting it, so without a timeout here this
// guard -- unlike the thing it replaced -- can wedge a button permanently:
// the very first click after that never releases the lock, and every
// click after it silently no-ops forever with zero console/network activity.
const inFlightToggles = new Set();
const TOGGLE_LOCK_TIMEOUT_MS = 20000;

async function guardedToggle(key, action) {
  if (inFlightToggles.has(key)) {
    return;
  }
  inFlightToggles.add(key);
  try {
    await Promise.race([
      action(),
      new Promise((resolve) =>
        setTimeout(resolve, TOGGLE_LOCK_TIMEOUT_MS)
      ),
    ]);
  } finally {
    inFlightToggles.delete(key);
  }
}

async function torchToggleWithPsuCheck(printer) {
  if (printer?.powerSettings?.powerStatusURL) {
    const isPoweredOn = await PrinterPowerService.printerIsPoweredOn(printer);
    if (!isPoweredOn) {
      return {
        status: bulkActionsStates.ERROR,
        message: `${printer.printerName}: Torch can't be turned on - PSU is off!`,
      };
    }
  }
  return printerTorchToggle(printer);
}

function returnActionBtnTemplate(id, webURL, disableWeb = false) {
  let disabledWebButton;
  if (disableWeb) {
    disabledWebButton = 'd-none';
  }
  // Depends on a custom OctoPrint plugin not every farm has installed --
  // hidden entirely unless an admin has confirmed it via the System settings
  // checkbox, rather than showing a button that 404s for most installs.
  const maintenanceModeHidden = window.OCTOFARM_FEATURES?.psuMaintenanceMode ? '' : 'd-none';
  return `
      <div class="btn-group dropright">
         <button  
           title="Quickly bring your printer online! Power -> Connect"
           id="printerQuickConnect-${id}"
           type="button"
           class="tag btn btn-danger btn-sm"
           >
              <i class="fas fa-toggle-off"></i>
        </button>
        <button
             title="Toggle the printer's light (WS281x LED Status plugin's torch mode)"
             id="printerTorch-${id}"
             type="button"
             class="tag btn btn-warning btn-sm"
        >
             <i class="fa-solid fa-lightbulb"></i>
        </button>
        <a title="Open OctoPrint"
               id="printerWeb-${id}"
               type="button"
               class="tag btn btn-info btn-sm ${disabledWebButton}"
               target="_blank"
               href="${webURL}" role="button"><i class="fas fa-globe-europe "></i> </a>   
        <button id="printerManageDropDown-${id}" type="button" class="btn btn-primary btn-sm dropdown-toggle dropdown-toggle-split" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">
         <i class="fas fa-bars"></i>
        </button>
        <div class="dropdown-menu">
          <h6 id="printerActionsHeader-${id}" class="dropdown-header"><i class="fas fa-print"></i>Printer Commands</h6>
          <button
             title="Homes your printers X,Y and Z"
             id="printerHome-${id}"
             type="button"
             class="dropdown-item"
          >
            <i class="fa-solid fa-house-flag text-success"></i> Home
          </button> 
          <button
             title="Sets all heater targets to 0"
             id="printerHeatersOff-${id}"
             type="button"
             class="dropdown-item"
          >
            <i class="fa-solid fa-temperature-arrow-down text-info"></i> Turn Off Heaters
          </button>
          <button
             title="Uses the values from your selected filament and pre-heats to those values."
             id="printerPreHeat-${id}"
             type="button"
             class="dropdown-item d-none"
          >
            <i class="fas fa-fire text-warning"></i> Pre-Heat
          </button> 
          <button
             title="Fires an M112 command to the printer!"
             id="printerEmergency-${id}"
             type="button"
             class="dropdown-item"
          >
            <i class="fa-solid fa-ban text-danger"></i> Emergency Stop
          </button>
          <button
             title="Locks the PSU on and disables its idle auto-off for manual/LCD-menu activity (e.g. calibration) that OctoPrint can't otherwise see"
             id="printerMaintenanceMode-${id}"
             type="button"
             class="dropdown-item ${maintenanceModeHidden}"
          >
            <i class="fa-solid fa-lock text-warning"></i> Toggle Maintenance Mode
          </button>
          <button id="printerPowerOn-${id}" title="Turn on your printer" class="dropdown-item d-none" href="#" disabled><i class="text-success fas fa-power-off"></i> Power On Printer</button>
          <button id="printerPowerOff-${id}" title="Turn off your printer" class="dropdown-item d-none" href="#" disabled><i class="text-danger fas fa-power-off"></i> Power Off Printer</button>
          <hr class="d-none">
          <h6 class="dropdown-header d-none"><i class="fa-solid fa-compress"></i> Actions</h6>
          <button  
           title="Runs a pre-configured gcode sequence so you can detect which printer this is."
           id="printerFindMe-${id}"
           type="button"
           class="dropdown-item d-none"
            disabled
        >
            <i class="fas fa-search text-info"></i> Find Printer!
          </button> 
          <hr>
          <h6 id="octoPrintHeader-${id}" class="dropdown-header d-none"><i class="fab fa-octopus-deploy"></i> OctoPrint</h6>
          <button
             title="Terminate and reconnect OctoPrints Socket connection."
             id="printerSyncButton-${id}"
             type="button"
             class="dropdown-item"
          >
              <i class="fas fa-sync text-warning"></i> Re-Connect Socket
          </button>   
          <button id="printerRestartOctoPrint-${id}" title="Restart OctoPrint Service" class="dropdown-item d-none" href="#"  disabled><i class="text-warning fas fa-redo"></i> Restart OctoPrint</button>
          <button id="printerRestartHost-${id}" title="Reboot OctoPrint Host" class="dropdown-item d-none" href="#" disabled><i class="text-warning fas fa-sync-alt"></i> Reboot Host</button>
          <button id="printerWakeHost-${id}" title="Wake up OctoPrint Host" class="dropdown-item d-none" href="#" disabled><i class="text-success fas fa-power-off"></i> Wake Host</button>
          <button id="printerShutdownHost-${id}" title="Shutdown OctoPrint Host" class="dropdown-item d-none" href="#" disabled><i class="text-danger fas fa-power-off"></i> Shutdown Host</button>
        </div>
      </div>
  `;
}

function printerQuickConnected(id) {
  let connectBtn = document.getElementById('printerQuickConnect-' + id);
  if (!connectBtn) {
    return;
  }
  connectBtn.innerHTML = '<i class="fas fa-toggle-on"></i>';
  connectBtn.classList.remove('btn-danger');
  connectBtn.classList.add('btn-success');
  connectBtn.title = 'Quickly take your printer offline! Disconnect -> Power Off';
}
function printerQuickDisconnected(id) {
  let connectBtn = document.getElementById('printerQuickConnect-' + id);
  if (!connectBtn) {
    return;
  }
  connectBtn.innerHTML = '<i class="fas fa-toggle-off"></i>';
  connectBtn.classList.remove('btn-success');
  connectBtn.classList.add('btn-danger');
  connectBtn.title = 'Quickly bring your printer online! Power -> Connect';
}

function groupInit(printers) {
  const uniqueGroupList = [...new Set(printers.map((printer) => printer.group))];
  uniqueGroupList.forEach((group) => {
    const cleanGroup = encodeURIComponent(group);
    const skipElement = document.getElementById(`printerQuickConnect-${cleanGroup}`);
    const groupContainer = document.getElementById(`printerActionBtns-${cleanGroup}`);
    const filteredGroupPrinterList = printers.filter((printer) => {
      if (encodeURIComponent(printer.group) === cleanGroup) {
        return printer;
      }
    });

    checkGroupQuickConnectState(filteredGroupPrinterList, cleanGroup);

    // Listeners attach to these same button elements below, so this has to
    // stay a single guard covering both -- calling this a second time on
    // buttons that already exist would stack a second click listener on top
    // of the first, and every click after that would fire the handler once
    // per stacked listener.
    if (!skipElement) {
      groupContainer.innerHTML = `
        ${returnActionBtnTemplate(`${cleanGroup}`, '', true)}
      `;
      addGroupEventListeners(filteredGroupPrinterList, cleanGroup);
    }
  });
}

function addGroupEventListeners(printers, group) {
  //Quick Connect
  document.getElementById(`printerQuickConnect-${group}`).addEventListener('click', async (e) => {
    e.disabled = true;
    if (document.getElementById('printerQuickConnect-' + group).classList.contains('btn-danger')) {
      for (const printer of printers) {
        const status = await connectPrinterSequence(printer);
        if (typeof status !== 'undefined') {
          if (status === 204) {
            UI.createAlert(
              'success',
              `Successfully made connection attempt to ${printer.printerName}...`,
              3000,
              'Clicked'
            );
          } else {
            UI.createAlert(
              'error',
              `There was an issue connecting to ${printer.printerName} it's either not online, or the connection options supplied are not available...`,
              3000,
              'Clicked'
            );
          }
        } else {
          UI.createAlert(
            'error',
            `No response from ${printer.printerName}, is it online???`,
            3000,
            'Clicked'
          );
        }
      }
    } else {
      bootbox.confirm({
        message: 'Are you sure you want to disconnect your printers?',
        buttons: {
          confirm: {
            label: 'Yes',
            className: 'btn-success',
          },
          cancel: {
            label: 'No',
            className: 'btn-danger',
          },
        },
        callback: async function (result) {
          if (result) {
            for (const printer of printers) {
              const status = await disconnectPrinterSequenceNoConfirm(printer);
              if (typeof status !== 'undefined') {
                if (status === 204) {
                  UI.createAlert(
                    'success',
                    `Successfully made disconnect attempt to ${printer.printerName}...`,
                    3000,
                    'Clicked'
                  );
                } else {
                  UI.createAlert(
                    'error',
                    `There was an issue disconnecting to ${printer.printerName} are you sure it's online?`,
                    3000,
                    'Clicked'
                  );
                }
              } else {
                UI.createAlert(
                  'error',
                  `No response from ${printer.printerName}, is it online???`,
                  3000,
                  'Clicked'
                );
              }
            }
          }
        },
      });
    }
  });

  //Re-Sync printer
  document.getElementById(`printerSyncButton-${group}`).addEventListener('click', async (e) => {
    e.target.disabled = true;
    for (const printer of printers) {
      const data = {
        id: printer._id,
      };
      let post = await OctoFarmClient.post('printers/reSyncSockets', data);
      if (post.msg.status !== 'error') {
        UI.createAlert('success', printer.printerName + ': ' + post.msg, 3000, 'clicked');
      } else {
        UI.createAlert('error', printer.printerName + ': ' + post.msg, 3000, 'clicked');
      }
    }
    e.target.disabled = false;
  });

  // Emergency Stop
  document.getElementById(`printerEmergency-${group}`).addEventListener('click', async (e) => {
    e.target.disabled = true;
    bootbox.confirm(
      'You are about to send "M112" to your printers, this will cause an emergency stop! Are you sure?',
      async function (result) {
        if (result) {
          for (const printer of printers) {
            const { status, message } = await printerEmergencyStop(printer);
            UI.createAlert(status, message, 3000, 'Clicked');
          }
          e.target.disabled = false;
        }
      }
    );
  });
  document.getElementById(`printerHome-${group}`).addEventListener('click', async (e) => {
    e.target.disabled = true;
    for (const printer of printers) {
      const { status, message } = await printerHomeAllAxis(printer);
      UI.createAlert(status, message, 3000, 'Clicked');
    }
    e.target.disabled = false;
  });

  document.getElementById(`printerHeatersOff-${group}`).addEventListener('click', async (e) => {
    e.target.disabled = true;
    for (const printer of printers) {
      const { status, message } = await printerTurnOffHeaters(printer);
      UI.createAlert(status, message, 3000, 'Clicked');
    }
    e.target.disabled = false;
  });

  document.getElementById(`printerTorch-${group}`).addEventListener('click', async (e) => {
    e.target.disabled = true;
    for (const printer of printers) {
      await guardedToggle(`torch-${printer._id}`, async () => {
        const { status, message } = await torchToggleWithPsuCheck(printer);
        UI.createAlert(status, message, 3000, 'Clicked');
      });
    }
    e.target.disabled = false;
  });

  document
    .getElementById(`printerMaintenanceMode-${group}`)
    .addEventListener('click', async (e) => {
      e.target.disabled = true;
      for (const printer of printers) {
        await guardedToggle(`maintenance-${printer._id}`, async () => {
          const { status, message } = await printerMaintenanceModeToggle(printer);
          UI.createAlert(status, message, 3000, 'Clicked');
        });
      }
      e.target.disabled = false;
    });
}

function init(printer, element) {
  document.getElementById(element).innerHTML = `
    ${returnActionBtnTemplate(printer._id, printer.printerURL)}
  `;
  checkQuickConnectState(printer);

  addEventListeners(printer);
}

function addEventListeners(printer) {
  //Quick Connect
  document
    .getElementById(`printerQuickConnect-${printer._id}`)
    .addEventListener('click', async (e) => {
      e.target.disabled = true;
      if (
        document
          .getElementById('printerQuickConnect-' + printer._id)
          .classList.contains('btn-danger')
      ) {
        // Connect Printer Sequence
        const status = await connectPrinterSequence(printer);
        if (typeof status !== 'undefined') {
          if (status === 204) {
            UI.createAlert('success', `${printer.printerName}: Brought online`, 3000, 'Clicked');
          } else {
            UI.createAlert(
              'error',
              `There was an issue connecting to ${printer.printerName} it's either not online, or the connection options supplied are not available...`,
              3000,
              'Clicked'
            );
          }
        } else {
          UI.createAlert(
            'error',
            `No response from ${printer.printerName}, is it online???`,
            3000,
            'Clicked'
          );
        }
      } else {
        // Disconnect Printer Sequence
        bootbox.confirm({
          message: 'Are you sure you want to shutdown your printer?',
          buttons: {
            confirm: {
              label: 'Yes',
              className: 'btn-success',
            },
            cancel: {
              label: 'No',
              className: 'btn-danger',
            },
          },
          callback: async function (result) {
            if (result) {
              const status = await disconnectPrinterSequenceNoConfirm(printer);
              if (!!status) {
                if (status === 204) {
                  UI.createAlert(
                    'success',
                    `${printer.printerName}: Disconnected!`,
                    3000,
                    'Clicked'
                  );
                } else {
                  UI.createAlert(
                    'error',
                    `There was an issue disconnecting to ${printer.printerName} are you sure it's online?`,
                    3000,
                    'Clicked'
                  );
                }
              } else {
                UI.createAlert(
                  'error',
                  `No response from ${printer.printerName}, is it online???`,
                  3000,
                  'Clicked'
                );
              }
            }
          },
        });
      }
    });
  //Re-Sync printer
  document
    .getElementById(`printerSyncButton-${printer._id}`)
    .addEventListener('click', async (e) => {
      e.target.disabled = true;
      const data = {
        id: printer._id,
      };
      let post = await OctoFarmClient.post('printers/reSyncSockets', data);
      if (post.status !== 'error') {
        UI.createAlert('success', post.msg, 3000, 'clicked');
      } else {
        UI.createAlert('error', post.msg, 3000, 'clicked');
      }
      e.target.disabled = false;
    });
  // Emergency Stop
  document
    .getElementById(`printerEmergency-${printer._id}`)
    .addEventListener('click', async (e) => {
      e.target.disabled = true;
      bootbox.confirm(
        'You are about to send "M112" to your printer, this will cause an emergency stop! Are you sure?',
        async function (result) {
          if (result) {
            const { status, message } = await printerEmergencyStop(printer);
            UI.createAlert(status, message, 3000, 'Clicked');
            e.target.disabled = false;
          }
        }
      );
    });
  document.getElementById(`printerHome-${printer._id}`).addEventListener('click', async (e) => {
    e.target.disabled = true;
    const { status, message } = await printerHomeAllAxis(printer);
    UI.createAlert(status, message, 3000, 'Clicked');
    e.target.disabled = false;
  });

  document
    .getElementById(`printerHeatersOff-${printer._id}`)
    .addEventListener('click', async (e) => {
      e.target.disabled = true;
      const { status, message } = await printerTurnOffHeaters(printer);
      UI.createAlert(status, message, 3000, 'Clicked');
      e.target.disabled = false;
    });

  // Not gated on printerIsIdle like Home/Turn Off Heaters -- the whole point of a
  // torch is to see what's happening on a printer that's mid-print.
  document.getElementById(`printerTorch-${printer._id}`).addEventListener('click', async (e) => {
    e.target.disabled = true;
    await guardedToggle(`torch-${printer._id}`, async () => {
      const { status, message } = await torchToggleWithPsuCheck(printer);
      UI.createAlert(status, message, 3000, 'Clicked');
    });
    e.target.disabled = false;
  });

  document
    .getElementById(`printerMaintenanceMode-${printer._id}`)
    .addEventListener('click', async (e) => {
      e.target.disabled = true;
      await guardedToggle(`maintenance-${printer._id}`, async () => {
        const { status, message } = await printerMaintenanceModeToggle(printer);
        UI.createAlert(status, message, 3000, 'Clicked');
      });
      e.target.disabled = false;
    });

  PrinterPowerService.setupEventListeners(printer);
}

function checkQuickConnectState(printer) {
  const isOnline = printerIsOnline(printer);
  const isPrinting = printerIsPrinting(printer);

  // Optional chaining throughout: one missing element used to throw here and
  // silently abort everything below it for this printer -- including the
  // Quick Connect ("Power") button's icon/class update at the bottom of this
  // function -- on every future tick, until the page was reloaded.
  //printerActionsHeader
  const setDisabled = (id, value) => {
    const el = document.getElementById(id);
    if (el) {
      el.disabled = value;
    }
  };
  setDisabled('printerSyncButton-' + printer._id, !isOnline);
  setDisabled('printerQuickConnect-' + printer._id, !isOnline);
  setDisabled('printerManageDropDown-' + printer._id, !isOnline);
  setDisabled('printerHome-' + printer._id, !printerIsIdle(printer));
  setDisabled('printerEmergency-' + printer._id, !isPrinting);
  setDisabled('printerHeatersOff-' + printer._id, !printerIsIdle(printer));
  setDisabled('printerTorch-' + printer._id, !isOnline);
  setDisabled('printerMaintenanceMode-' + printer._id, !isOnline);

  PrinterPowerService.revealPowerButtons(printer).catch((e) => {
    console.error(e);
  });

  if (typeof printer.connectionOptions !== 'undefined') {
    if (
      printer.connectionOptions?.portPreference === null ||
      printer.connectionOptions?.baudratePreference === null ||
      printer.connectionOptions?.printerProfilePreference === null
    ) {
      setDisabled('printerQuickConnect-' + printer._id, true);
    }
  } else {
    setDisabled('printerQuickConnect-' + printer._id, true);
  }

  if (!isOnline) {
    printerQuickDisconnected(printer._id);
    return;
  }

  if (printerIsDisconnectedOrError(printer)) {
    printerQuickDisconnected(printer._id);
    return;
  }

  printerQuickConnected(printer._id);
}

function checkGroupQuickConnectState(printers, group) {
  const printersAllOnline = printers.filter((printer) => printerIsOnline(printer)).length;
  const printersAllIdle = printers.filter((printer) => printerIsIdle(printer)).length;
  const printersAllPrinting = printers.filter((printer) => printerIsPrinting(printer)).length;
  const printersAllDisconnectedOrError = printers.filter((printer) =>
    printerIsDisconnectedOrError(printer)
  ).length;
  const setGroupDisabled = (id, value) => {
    const el = document.getElementById(id);
    if (el) {
      el.disabled = value;
    }
  };
  setGroupDisabled('printerSyncButton-' + group, !printersAllOnline > 0);
  setGroupDisabled('printerQuickConnect-' + group, !printersAllOnline > 0);
  setGroupDisabled('printerManageDropDown-' + group, !printersAllOnline > 0);
  setGroupDisabled('printerHome-' + group, !printersAllIdle);
  setGroupDisabled('printerEmergency-' + group, !printersAllPrinting);
  setGroupDisabled('printerHeatersOff-' + group, !printersAllIdle);
  setGroupDisabled('printerTorch-' + group, !printersAllOnline > 0);
  setGroupDisabled('printerMaintenanceMode-' + group, !printersAllOnline > 0);
  const noConnectionOptions = printers.filter(
    (obj) =>
      obj?.connectionOptions?.portPreference === null ||
      obj?.connectionOptions?.baudratePreference === null ||
      obj?.connectionOptions?.printerProfilePreference === null
  ).length;
  if (noConnectionOptions > 0) {
    setGroupDisabled('printerQuickConnect-' + group, true);
  }
  if (printersAllDisconnectedOrError > 0) {
    printerQuickDisconnected(group);
  } else if (printersAllDisconnectedOrError === 0) {
    printerQuickConnected(group);
  } else {
    printerQuickDisconnected(group);
  }
}

export {
  init,
  groupInit,
  printerQuickConnected,
  printerQuickDisconnected,
  checkQuickConnectState,
  checkGroupQuickConnectState,
};
