const Profiles = require('../models/Profiles');

const attachProfileToSpool = async (id) => {
  const profile = await Profiles.findById(id);
  return profile.profile;
};

module.exports = {
  attachProfileToSpool,
};
