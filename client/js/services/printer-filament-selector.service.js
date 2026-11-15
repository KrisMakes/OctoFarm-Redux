import OctoFarmClient from './octofarm-client.service';
import { isFilamentManagerPluginSyncEnabled } from './octoprint/filament-manager-plugin.service';
import { selectFilament } from '../pages/filament-manager/filament-manager.actions';
import { spoolNumberLabel } from '../pages/filament-manager/filament-manager.templates';
import { escapeHtml } from '../utils/html.utils';

const dropDownListTemplate = (spool, multiSelect) => {
  const { spoolID, spoolNumber, spoolRemain, spoolMaterial, spoolManufacturer, selected } = spool;
  const spoolName = [spoolNumberLabel(spoolNumber), spool.spoolName].filter(Boolean).join(' ');
  let disabled = '';
  if (selected && !multiSelect) {
    disabled = 'disabled';
  }
  const label = multiSelect
    ? `${spoolName} - ${spoolMaterial} (${spoolManufacturer})`
    : `${spoolName} (${spoolRemain}g) - ${spoolMaterial} (${spoolManufacturer})`;
  // The label goes in a title too: the selectors are narrow enough that a spool
  // name is usually cut off mid-word, and `setSelectTooltip` copies the chosen
  // option's title onto the select so hovering the box shows the whole thing.
  return `
        <option value="${escapeHtml(spoolID)}" ${disabled} title="${escapeHtml(
    label
  )}">${escapeHtml(label)}</option>
    `;
};

/**
 * Mirror the selected option's label onto the <select> itself, so hovering the
 * collapsed box reveals the full spool name that the fixed width truncates.
 * "No Spool" is the placeholder rather than a name, so it gets no tooltip.
 */
export const setSelectTooltip = (element) => {
  if (!element) {
    return;
  }
  const selected = element.options[element.selectedIndex];
  const label = selected?.text?.trim();
  if (!label || element.value === '0') {
    element.removeAttribute('title');
  } else {
    element.title = label;
  }
};

export const findBigFilamentDropDowns = () => {
  return document.querySelectorAll('[id$=bigFilamentSelect]');
};

export const findMiniFilamentDropDownsSelect = (printerID, toolIndex) => {
  return document.getElementById(`tool-${printerID}-${toolIndex}-miniFilamentSelect`);
};

export const returnBigFilamentSelectorTemplate = (toolNumber, printerID = undefined) => {
  let toolID = toolNumber;
  if (!!printerID) {
    toolID = `${printerID}-${toolNumber}`;
  }
  return `
      <div class="md-form input-group mb-3">
        <div title="Actual Tool temperature" class="input-group-prepend">
            <span class="input-group-text"><span>${toolNumber}: </span></span>
        </div>
        <select class="custom-select bg-secondary text-light" id="tool-${toolID}-bigFilamentSelect"></select>
      </div>
    `;
};

export const returnMiniFilamentSelectorTemplate = (printerID, toolNumber) => {
  return `
        <div class="input-group input-group-sm btn-block m-0">
            <div class="input-group-prepend">
                <label class="input-group-text" for="tool-${printerID}-${toolNumber}-miniFilamentSelect"><b>Tool ${toolNumber} </b></label>
            </div>
            <select class="custom-select bg-secondary text-light" id="tool-${printerID}-${toolNumber}-miniFilamentSelect"></select>
            <div class="input-group-append">
                <span id="${printerID}-temperature-${toolNumber}" class="input-group-text" title="Actual / target tool temperature">
                    <i class="far fa-circle"></i>&nbsp;0°C&nbsp;<i class="fas fa-bullseye"></i>&nbsp;0°C</span>
            </div>
        </div>
    `;
};

export async function returnDropDownList() {
  const { dropDownList } = await OctoFarmClient.get('filament/get/dropDownList');
  return dropDownList;
}

export async function fillMiniFilamentDropDownList(element, printer, toolIndex, dropDownList) {
  await redrawMiniFilamentDropDownList(element, printer, toolIndex, dropDownList);
  element.addEventListener('change', async (event) => {
    await selectFilament([`${printer._id}-${toolIndex}`], event.target.value);
    await redrawMiniFilamentDropDownList(element, printer, toolIndex, dropDownList);
  });
}

async function redrawMiniFilamentDropDownList(element, printer, toolIndex, filamentDropDown) {
  element.innerHTML = '';
  const { allowMultiSelectIsEnabled } = await isFilamentManagerPluginSyncEnabled();
  element.insertAdjacentHTML('beforeend', '<option value="0">No Spool</option>');
  filamentDropDown.forEach((spool) => {
    element.insertAdjacentHTML('beforeend', dropDownListTemplate(spool, allowMultiSelectIsEnabled));
  });
  const { _id: printerID } = printer;
  const selectedFilament = await OctoFarmClient.getSelectedFilament(printerID);
  if (Array.isArray(selectedFilament) && selectedFilament.length !== 0) {
    if (!!selectedFilament[toolIndex]) {
      element.value = selectedFilament[toolIndex]._id;
    }
  }
  setSelectTooltip(element);
}

async function redrawFilamentDropDownList(element, printer, toolIndex) {
  element.innerHTML = '';
  const filamentDropDown = await returnDropDownList();
  const { allowMultiSelectIsEnabled } = await isFilamentManagerPluginSyncEnabled();
  element.insertAdjacentHTML('beforeend', '<option value="0">No Spool</option>');
  filamentDropDown.forEach((spool) => {
    element.insertAdjacentHTML('beforeend', dropDownListTemplate(spool, allowMultiSelectIsEnabled));
  });
  const { _id: printerID } = printer;
  const selectedFilament = await OctoFarmClient.getSelectedFilament(printerID);
  if (Array.isArray(selectedFilament) && selectedFilament.length !== 0) {
    if (!!selectedFilament[toolIndex]) {
      element.value = selectedFilament[toolIndex]._id;
    }
  }
  setSelectTooltip(element);
}

export async function drawHistoryDropDown(element, selectedID) {
  element.innerHTML = '';
  const filamentDropDown = await returnDropDownList();
  element.insertAdjacentHTML('beforeend', '<option value="0">No Spool</option>');
  filamentDropDown.forEach((spool) => {
    element.insertAdjacentHTML('beforeend', dropDownListTemplate(spool, true));
  });
  if (!!selectedID) {
    element.value = selectedID;
  } else {
    element.value = '0';
  }
  setSelectTooltip(element);
}

export async function fillFilamentDropDownList(element, printer, toolIndex) {
  await redrawFilamentDropDownList(element, printer, toolIndex);
  element.addEventListener('change', async (event) => {
    await selectFilament([`${printer._id}-${toolIndex}`], event.target.value);
    await redrawFilamentDropDownList(element, printer, toolIndex);
  });
}
