const { statSync, readFileSync } = require('fs');

// Replaces the is-docker package, which is ESM only from version 3. Every
// caller here uses it synchronously, so a dynamic import is not an option and
// the package cannot be upgraded. The check itself is two filesystem probes,
// unchanged across that package's releases, so we own it rather than pin a
// dependency that can no longer be required.
let cached;

const hasDockerEnvFile = () => {
  try {
    statSync('/.dockerenv');
    return true;
  } catch {
    return false;
  }
};

const hasDockerCGroup = () => {
  try {
    return readFileSync('/proc/self/cgroup', 'utf8').includes('docker');
  } catch {
    return false;
  }
};

module.exports = function isDocker() {
  if (cached === undefined) {
    cached = hasDockerEnvFile() || hasDockerCGroup();
  }
  return cached;
};
