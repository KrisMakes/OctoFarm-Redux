const { findIndex } = require('lodash');
const { parseOutIPAddress } = require('./url.utils');
const { AppConstants } = require('../constants/app.constants');

const findFileIndex = (fileList, fullPath) => {
  return findIndex(fileList.files, function (o) {
    return o.fullPath === fullPath;
  });
};

const matchRemoteAddressToOctoFarm = (networkIpAddresses, remoteAddress) => {
  // parseOutIPAddress answers false for anything without an IP in it, so a bare
  // pass-through would return the boolean and render as 'false'.
  const parsedAddress = parseOutIPAddress(remoteAddress);

  if (parsedAddress && networkIpAddresses.includes(parsedAddress)) {
    return (
      process.env[AppConstants.OCTOFARM_SITE_TITLE_KEY] || AppConstants.defaultOctoFarmPageTitle
    );
  }

  return parsedAddress || 'Unknown IP';
};

module.exports = {
  findFileIndex,
  matchRemoteAddressToOctoFarm,
};
