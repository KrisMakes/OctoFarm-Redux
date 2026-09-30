const { SettingsClean } = require('../services/settings-cleaner.service');

const noCostSettingsMessage = 'No cost settings to calculate from';

// Both default to on: an unset value (or settings that have not been cleaned
// yet) has to mean "include", or every cost on the farm reads zero on boot.
function isElectricityCostIncluded() {
  return SettingsClean.returnSystemSettings()?.filament?.includeElectricityCost !== false;
}

function isMaintenanceCostIncluded() {
  return SettingsClean.returnSystemSettings()?.filament?.includeMaintenanceCost !== false;
}

/**
 * Calculate the cost of printing
 * @param printTime
 * @param costSettings
 * @returns {number|string|null} null when the user has excluded this cost line
 */
function getMaintenanceCosts(printTime, costSettings) {
  if (!isMaintenanceCostIncluded()) {
    return null;
  }
  if (!costSettings) {
    // Attempt to update cost settings in history...
    return noCostSettingsMessage;
  }
  // calculating printer cost
  const purchasePrice = parseFloat(costSettings.purchasePrice);
  const lifespan = parseFloat(costSettings.estimateLifespan);
  const depreciationPerHour = lifespan > 0 ? purchasePrice / lifespan : 0;
  const maintenancePerHour = parseFloat(costSettings.maintenanceCosts);
  const estimatedPrintTime = getEstimatedPrintTime(printTime);

  const cost = (depreciationPerHour + maintenancePerHour) * estimatedPrintTime;

  // assembling string
  return !!cost ? cost : 0;
}

function getEstimatedPrintTime(printTime) {
  return printTime / 3600;
}

/**
 * @returns {number|string|null} null when the user has excluded this cost line
 */
function getElectricityCosts(printTime, costSettings) {
  if (!isElectricityCostIncluded()) {
    return null;
  }
  if (!costSettings) {
    return noCostSettingsMessage;
  }
  const powerConsumption = parseFloat(costSettings.powerConsumption);
  const costOfElectricity = parseFloat(costSettings.electricityCosts);
  const costPerHour = powerConsumption * costOfElectricity;
  const estimatedPrintTime = getEstimatedPrintTime(printTime); // h

  const cost = costPerHour * estimatedPrintTime;

  return !!cost ? cost : 0;
}

/**
 * Add up whichever printer cost lines are still switched on. Null -- rather
 * than 0 -- when every line is excluded, so the interfaces can drop the row
 * instead of printing a 0.00 the user asked not to see.
 * @returns {number|null}
 */
function getPrinterCost(electricityCosts, maintenanceCosts) {
  const included = [electricityCosts, maintenanceCosts].filter(
    (cost) => typeof cost === 'number' && Number.isFinite(cost)
  );
  if (!included.length) {
    return null;
  }
  return included.reduce((a, b) => a + b, 0);
}

module.exports = {
  noCostSettingsMessage,
  getMaintenanceCosts,
  getElectricityCosts,
  getPrinterCost,
  isElectricityCostIncluded,
  isMaintenanceCostIncluded,
};
