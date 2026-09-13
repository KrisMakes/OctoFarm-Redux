import OctoFarmClient from '../octofarm-client.service';
import { isEmpty } from 'lodash';
let filamentManagerSettings = {};

export async function isFilamentManagerPluginSyncEnabled() {
  if (isEmpty(filamentManagerSettings)) {
    const {
      filament: { allowMultiSelect },
    } = await OctoFarmClient.get('settings/server/get');
    filamentManagerSettings.allowMultiSelectIsEnabled = allowMultiSelect;
  }
  return {
    allowMultiSelectIsEnabled: filamentManagerSettings.allowMultiSelectIsEnabled,
  };
}
