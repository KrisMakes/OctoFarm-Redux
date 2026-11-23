// OctoPrint 2.0 dropped the derived `admin` flag from user payloads: group
// membership is now the only record of it. `groups` has been there since the
// 1.4.0 access-control rework, so it is the test that works on every supported
// version -- `admin` is kept purely as a belt-and-braces fallback. Without this
// the user list came back empty on 2.0, and an empty user list is a hard
// shutdown for the printer.
const isOctoPrintAdmin = (user) =>
  !!user?.admin || (Array.isArray(user?.groups) && user.groups.includes('admins'));

const parseAllOctoPrintUsers = (userList) => {
  const users = [];
  for (let currentUser of userList) {
    if (isOctoPrintAdmin(currentUser)) {
      if (!users.includes(currentUser.name)) {
        users.push(currentUser.name);
      }
    }
  }
  return users;
};

const findCurrentUserForOctoFarmConnection = (userList) => {
  let selectedUser;
  for (const user of userList) {
    // First check if we have "octofarm" user...
    if (user.toLowerCase() === 'octofarm') {
      selectedUser = user;
      break;
    }
    // Second check if we have an octofarm based user...
    if (user.toLowerCase().includes('octofarm')) {
      selectedUser = user;
      break;
    }
  }
  //fall back to first user in list as no user could be found
  if (!selectedUser) {
    selectedUser = userList[0];
  }
  return selectedUser;
};

module.exports = {
  parseAllOctoPrintUsers,
  findCurrentUserForOctoFarmConnection,
};
