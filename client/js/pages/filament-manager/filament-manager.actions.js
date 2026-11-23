import OctoFarmClient from '../../services/octofarm-client.service';
import UI from '../../utils/ui';
import { reRenderPageInformation, printErrors, getSelectValues } from './filament-manager-ui.utils';
import { formatSpoolRemaining, formatSpoolUsed } from './filament-manager.templates';
import { escapeHtml } from '../../utils/html.utils';

export async function selectFilament(spools, id) {
  let printerIds = [];
  for (const spool of spools) {
    const meta = spool.split('-');

    printerIds.push({
      printer: meta[0],
      tool: meta[1],
    });
  }
  await OctoFarmClient.post('/filament/assign', {
    printers: printerIds,
    spoolId: id,
  });
}

export const editProfile = async (e) => {
  const row = e.parentElement.parentElement;
  const editable = row.querySelectorAll('input');
  const id = e.parentElement.parentElement.firstElementChild.innerHTML.trim();
  editable.forEach((edit) => {
    edit.disabled = false;
    edit.value = edit.placeholder;
  });
  document.getElementById(`save-${id}`).classList.remove('d-none');
  document.getElementById(`edit-${id}`).classList.add('d-none');
};
export const saveProfile = async (e) => {
  const row = e.parentElement.parentElement;
  const editable = row.querySelectorAll('input');
  const id = e.parentElement.parentElement.firstElementChild.innerHTML.trim();
  const profile = [];
  editable.forEach((edit) => {
    edit.disabled = true;
    edit.placeholder = edit.value;
    profile.push(edit.value);
    edit.value = '';
  });
  const data = {
    id,
    profile,
  };
  let post = await OctoFarmClient.post('filament/edit/profile', data);
  if (post && post.errors.length === 0) {
    document.getElementById(`save-${id}`).classList.add('d-none');
    document.getElementById(`edit-${id}`).classList.remove('d-none');

    await reRenderPageInformation();
  } else {
    printErrors(post.errors);
  }
};
export const deleteProfile = async (e) => {
  document.getElementById('profilesMessage').innerHTML = '';
  if (e.classList.contains('delete') || e.classList.contains('deleteIcon')) {
    let post = await OctoFarmClient.post('filament/delete/profile', {
      id: e.parentElement.parentElement.firstElementChild.innerHTML.trim(),
    });
    if (post && post.errors.length === 0) {
      if (e.classList.contains('deleteIcon')) {
        jplist.resetContent(function () {
          // remove element with id = el1
          e.parentElement.parentElement.parentElement.remove();
        });
      } else {
        jplist.resetContent(function () {
          // remove element with id = el1
          e.parentElement.parentElement.remove();
        });
      }
      UI.createAlert('success', 'Successfully deleted your profile!', 3000, 'Clicked');
    } else {
      printErrors(post.errors);
    }
  }
};

// Spool functions
export const addSpool = async (
  spoolsName,
  spoolsProfile,
  spoolsPrice,
  spoolsWeight,
  spoolsUsed,
  spoolsTempOffset,
  spoolsBedOffset,
  spoolsNumber
) => {
  const errors = [];

  if (spoolsName.value === '') {
    errors.push({ type: 'warning', msg: 'Please input a spool name' });
  }
  if (spoolsProfile.value === '') {
    errors.push({ type: 'warning', msg: 'Please select a profile' });
  }
  if (spoolsPrice.value === '') {
    errors.push({ type: 'warning', msg: 'Please input a spool price' });
  }
  if (spoolsWeight.value === 0 || spoolsWeight.value === '') {
    errors.push({ type: 'warning', msg: 'Please input a spool weight' });
  }
  if (spoolsUsed.value === '') {
    errors.push({ type: 'warning', msg: 'Please input spool used weight' });
  }

  if (errors.length > 0) {
    errors.forEach((error) => {
      UI.createMessage(error, 'addSpoolsMessage');
    });
    return;
  }
  const opts = {
    spoolsName: spoolsName.value,
    spoolsProfile: spoolsProfile.value,
    spoolsPrice: spoolsPrice.value,
    spoolsWeight: spoolsWeight.value,
    spoolsUsed: spoolsUsed.value,
    spoolsTempOffset: spoolsTempOffset.value,
    spoolsBedOffset: spoolsBedOffset.value,
    spoolsNumber: spoolsNumber?.value,
  };
  let post = await OctoFarmClient.post('filament/save/filament', opts);

  // Was `post || ...`, which reported any answer at all as a success -- a
  // refused spool number included.
  if (post && post.errors?.length === 0) {
    UI.createMessage(
      {
        type: 'success',
        msg: 'Successfully added new roll to the database...',
      },
      'addSpoolsMessage'
    );

    spoolsName.value = '';
    spoolsPrice.value = '';
    spoolsWeight.value = 1000;
    spoolsUsed.value = 0;
    spoolsTempOffset.value = 0.0;
    spoolsBedOffset.value = 0;
    if (spoolsNumber) {
      spoolsNumber.value = '';
    }
    await reRenderPageInformation();
    return true;
  } else {
    printErrors(post?.errors ?? []);
    return false;
  }
};
// Profile functions
export const addProfile = async (manufacturer, material, density, diameter) => {
  const errors = [];

  if (manufacturer.value === '') {
    errors.push({ type: 'warning', msg: 'Please input manufacturer' });
  }
  if (material.value === '') {
    errors.push({ type: 'warning', msg: 'Please select or type a material' });
  }
  if (density.value === 0) {
    errors.push({ type: 'warning', msg: 'Please input a density' });
  }
  if (diameter.value === 0) {
    errors.push({ type: 'warning', msg: 'Please input a density' });
  }
  if (errors.length > 0) {
    errors.forEach((error) => {
      UI.createMessage(error, 'profilesMessage');
    });
    return;
  }
  const opts = {
    manufacturer: manufacturer.value,
    material: material.value,
    density: density.value,
    diameter: diameter.value,
  };
  let post = await OctoFarmClient.post('filament/save/profile', opts);
  if (post && post?.errors.length === 0) {
    UI.createMessage(
      {
        type: 'success',
        msg: 'Successfully added new profile to the database...',
      },
      'profilesMessage'
    );
    manufacturer.value = '';
    material.value = '';
    density.value = 1.25;
    diameter.value = 1.75;
    await reRenderPageInformation();
  } else {
    printErrors(post?.errors);
  }
};

export const editSpool = async (e) => {
  UI.captureScrollPosition(document.getElementById('addSpoolModalBody'));
  const row = e.parentElement.parentElement;
  const editable = row.querySelectorAll('input');
  const id = e.parentElement.parentElement.firstElementChild.innerHTML.trim();
  editable.forEach((edit) => {
    edit.disabled = false;
    // Used shows whole grams but carries the exact amount in data-exact, so
    // saving a change to some other field on the row re-posts the precise
    // figure instead of the rounded one on display.
    edit.value = edit.dataset.exact ?? edit.placeholder;
  });
  document.getElementById(`spoolsPrinterAssignment-${id}`).disabled = false;
  document.getElementById(`spoolsProfile-${id}`).disabled = false;
  document.getElementById(`save-${id}`).classList.remove('d-none');
  document.getElementById(`edit-${id}`).classList.add('d-none');
};
export const deleteSpool = async (e) => {
  document.getElementById('profilesMessage').innerHTML = '';
  if (e.classList.contains('delete') || e.classList.contains('deleteIcon')) {
    let post = await OctoFarmClient.post('filament/delete/filament', {
      id: e.parentElement.parentElement.firstElementChild.innerHTML.trim(),
    });
    if (post && post.errors.length === 0) {
      if (e.classList.contains('deleteIcon')) {
        jplist.resetContent(function () {
          // remove element with id = el1
          e.parentElement.parentElement.parentElement.remove();
        });
      } else {
        jplist.resetContent(function () {
          // remove element with id = el1
          e.parentElement.parentElement.remove();
        });
      }
    } else {
      printErrors(post.errors);
    }
  }
};
export const saveSpool = async (e) => {
  const row = e.parentElement.parentElement;
  // The number travels on its own: the route reads the rest by position.
  const numberInput = row.querySelector('input.spool-number');
  const editable = row.querySelectorAll('input:not(.spool-number)');
  const id = e.parentElement.parentElement.firstElementChild.innerHTML.trim();
  const spoolNumber = numberInput.value;
  numberInput.disabled = true;
  numberInput.value = '';
  const spool = [];
  editable.forEach((edit) => {
    edit.disabled = true;
    spool.push(edit.value);
    if ('exact' in edit.dataset) {
      edit.dataset.exact = edit.value;
      edit.placeholder = formatSpoolUsed(edit.value);
    } else {
      edit.placeholder = edit.value;
    }
    edit.value = '';
  });

  spool.push(document.getElementById(`spoolsProfile-${id}`).value);
  const data = {
    id,
    spool,
    spoolNumber,
  };
  let post = await OctoFarmClient.post('filament/edit/filament', data);
  if (post && post.errors.length === 0) {
    // The remaining column is derived, so nothing else refreshes it.
    const remaining = formatSpoolRemaining(spool[2], spool[3]);
    row.querySelector('.spool-remaining').textContent = remaining;
    row.querySelector('.grams').textContent = remaining;
    numberInput.placeholder = post.spoolNumber ?? '';
    row.querySelector('.spoolNumber').textContent = post.spoolNumber ?? '';
    document.getElementById(`spoolsPrinterAssignment-${id}`).disabled = true;
    document.getElementById(`spoolsProfile-${id}`).disabled = true;
    document.getElementById(`save-${id}`).classList.add('d-none');
    document.getElementById(`edit-${id}`).classList.remove('d-none');

    await selectFilament(
      getSelectValues(document.getElementById(`spoolsPrinterAssignment-${id}`)),
      id
    );
    await reRenderPageInformation();
  } else {
    printErrors(post.errors);
  }
  // UI.reApplyScrollPosition(document.getElementById("addSpoolModalBody"))
};

// Putting a fresh roll on an existing spool entry. Clearing `used` by hand
// meant opening the row for editing and remembering which box held the figure;
// deleting and re-adding the spool lost its number, offsets and printer
// assignment. Everything but the used weight is left alone.
export const resetSpool = async (e) => {
  const row = e.parentElement.parentElement;
  const id = row.firstElementChild.innerHTML.trim();
  const name = row.querySelector('.name')?.textContent ?? 'this spool';
  const usedInput = row.querySelector('input[data-exact]');
  const weight = row.querySelector('.weight')?.textContent;

  const confirmed = await new Promise((resolve) => {
    bootbox.confirm({
      title: 'Reset spool?',
      // bootbox renders these with jQuery's .html(), and the spool name is
      // whatever the user typed. See escapeHtml.
      message: `Set the used weight of <b>${escapeHtml(
        name
      )}</b> back to 0g? Its number, profile, price, offsets and printer assignment stay as they are. Past print history is not affected.`,
      buttons: {
        confirm: { label: 'Reset', className: 'btn-warning' },
        cancel: { label: 'Cancel', className: 'btn-secondary' },
      },
      callback: resolve,
    });
  });
  if (!confirmed) {
    return;
  }

  const post = await OctoFarmClient.post('filament/reset/filament', { id });
  if (post && post.errors.length === 0) {
    // The row is rendered once and patched in place, so the reset has to be
    // reflected in both the displayed figure and the exact one that editing
    // the row would re-post.
    if (usedInput) {
      usedInput.dataset.exact = 0;
      usedInput.placeholder = formatSpoolUsed(0);
    }
    const remaining = formatSpoolRemaining(weight, 0);
    row.querySelector('.spool-remaining').textContent = remaining;
    row.querySelector('.grams').textContent = remaining;
    UI.createAlert('success', `Reset the used weight of ${name}.`, 3000, 'Clicked');
    await reRenderPageInformation();
  } else {
    printErrors(post?.errors ?? []);
  }
};

export const unAssignSpool = async (e) => {
  const id = e.parentElement.parentElement.firstElementChild.innerHTML.trim();
  await selectFilament(['0'], id);
  await reRenderPageInformation();
};
