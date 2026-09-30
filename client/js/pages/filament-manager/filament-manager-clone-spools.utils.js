import {
  updateProfileDrop,
  updatePrinterDrops,
  reRenderPageInformation,
} from './filament-manager-ui.utils';
import { addSpool } from './filament-manager.actions';
import { pageElements } from './filament-manager.utils';

// A copy counter is a number at the END of the name, not the first digits that
// happen to appear in it. This used to increment the first run of digits
// anywhere in the string, so cloning "3DJake ecoPLA Black" produced "4DJake
// ecoPLA Black" -- it counted up the brand. Names that do not end in a number
// get a "(2)" suffix instead of having their contents rewritten.
const CLONE_COUNTER_IN_BRACKETS = /^(.*?)\((\d+)\)\s*$/;
const CLONE_COUNTER_AT_END = /^(.*\s)(\d+)\s*$/;

// "09" -> "10", "007" -> "008": whatever padding the original used, keep it.
const keepPadding = (original, value) => String(value).padStart(original.length, '0');

export const nameForClone = (name, step) => {
  const bracketed = name.match(CLONE_COUNTER_IN_BRACKETS);
  if (bracketed) {
    const next = parseInt(bracketed[2], 10) + step;
    return `${bracketed[1]}(${keepPadding(bracketed[2], next)})`;
  }

  const trailing = name.match(CLONE_COUNTER_AT_END);
  if (trailing) {
    const next = parseInt(trailing[2], 10) + step;
    return `${trailing[1]}${keepPadding(trailing[2], next)}`;
  }

  return `${name} (${step + 1})`;
};

export const cloneSpool = async (e) => {
  const row = e.parentElement.parentElement;
  const editable = row.querySelectorAll('input:not(.spool-number)');
  const spool = [];
  editable.forEach((edit) => {
    spool.push(edit.placeholder);
  });

  const nextSpoolIndex = pageElements.spoolsManagerTable.rows.length;
  const spoolClonedId = row.id;
  const clonedRowID = `clonedRow-${spoolClonedId}-`;
  const currentSpoolsClonedCount = document.querySelectorAll(`[id^=${clonedRowID}]`).length + 1;

  let spoolName = nameForClone(spool[0], currentSpoolsClonedCount);

  document.getElementById(row.id).insertAdjacentHTML(
    'afterend',
    `
              <tr id="clonedRow-${spoolClonedId}-${nextSpoolIndex}">
                <th style="display: none;">${nextSpoolIndex}</th>
                <td><input id="clonedNumber-${spoolClonedId}-${nextSpoolIndex}" class="form-control" type="number" min="1" step="1" placeholder="Auto" value=""></td>
                <th scope="row"><input id="clonedName-${spoolClonedId}-${nextSpoolIndex}" class="form-control" type="text" placeholder="${spoolName}" value="${spoolName}"></th>
                <td>
                     <span class="d-none material" id="spoolsMaterialText-${spoolClonedId}-${nextSpoolIndex}"></span>
                     <select id="spoolsProfile-${spoolClonedId}-${nextSpoolIndex}" class="form-control">

                     </select>
                 </td>
                <td><input id="clonedPrice-${spoolClonedId}-${nextSpoolIndex}" class="form-control" type="text" step="0.01" placeholder="${spool[1]}" value="${spool[1]}"></td>
                <td><input id="clonedWeight-${spoolClonedId}-${nextSpoolIndex}" class="form-control" type="text" placeholder="${spool[2]}" value="1000"></td>
                <td><input id="clonedUsed-${spoolClonedId}-${nextSpoolIndex}" class="form-control" type="text" placeholder="0" value="0"></td>
                <td></td>
                <td><input id="clonedToolOffset-${spoolClonedId}-${nextSpoolIndex}" class="form-control" type="text" placeholder="${spool[4]}" value="${spool[4]}"></td>
                <td><input id="clonedBedOffset-${spoolClonedId}-${nextSpoolIndex}" class="form-control" type="text" placeholder="${spool[5]}" value="${spool[5]}"></td>
                 <td>
                     <select id="spoolsPrinterAssignment-${spoolClonedId}-${nextSpoolIndex}" class="form-control" disabled>

                     </select>
                 </td>
                 <td>
                <button id="clonedSave-${spoolClonedId}-${nextSpoolIndex}" type="button" class="btn btn-sm btn-success">
                  <i class="fas fa-save saveIcon"></i>
                </button>
                <button id="clonedDelete-${spoolClonedId}-${nextSpoolIndex}" type="button" class="btn btn-sm btn-danger">
                  <i class="fas fa-trash saveIcon"></i>
                </button>
                </td>
              </tr>
              `
  );

  await updateProfileDrop();
  await updatePrinterDrops();
  document.getElementById(`spoolsProfile-${spoolClonedId}-${nextSpoolIndex}`).selectedIndex = 0;
  const spoolPrinterAssignment = document.getElementById(
    `spoolsPrinterAssignment-${spoolClonedId}-${nextSpoolIndex}`
  );
  spoolPrinterAssignment.selectedIndex = 0;

  document
    .getElementById(`clonedSave-${spoolClonedId}-${nextSpoolIndex}`)
    .addEventListener('click', async function () {
      const clonedRow = document.getElementById(`clonedRow-${spoolClonedId}-${nextSpoolIndex}`);
      const addedSpool = await addSpool(
        document.getElementById(`clonedName-${spoolClonedId}-${nextSpoolIndex}`),
        document.getElementById(`spoolsProfile-${spoolClonedId}-${nextSpoolIndex}`),
        document.getElementById(`clonedPrice-${spoolClonedId}-${nextSpoolIndex}`),
        document.getElementById(`clonedWeight-${spoolClonedId}-${nextSpoolIndex}`),
        document.getElementById(`clonedUsed-${spoolClonedId}-${nextSpoolIndex}`),
        document.getElementById(`clonedToolOffset-${spoolClonedId}-${nextSpoolIndex}`),
        document.getElementById(`clonedBedOffset-${spoolClonedId}-${nextSpoolIndex}`),
        document.getElementById(`clonedNumber-${spoolClonedId}-${nextSpoolIndex}`)
      );
      if (addedSpool) {
        // Remove Row
        clonedRow.remove();
      }

      await reRenderPageInformation();
    });

  document
    .getElementById(`clonedDelete-${spoolClonedId}-${nextSpoolIndex}`)
    .addEventListener('click', function () {
      const clonedRow = document.getElementById(`clonedRow-${spoolClonedId}-${nextSpoolIndex}`);
      clonedRow.remove();
    });
};
