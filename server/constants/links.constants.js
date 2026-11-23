// Every outbound link in the app comes from here.
//
// The upstream OctoFarm domains are gone: octofarm.net and docs.octofarm.net
// both return 410, and octofarm.net/sponsor now resolves to a parked domain.
// Nothing may point at them again. The fork has no documentation site, so the
// repository and its README are the documentation.
//
// The client has its own copy at client/js/constants/links.constants.js
// because nothing under client/ imports from server/. Change both together.

const REPO_URL = 'https://github.com/KrisMakes/OctoFarm-Redux';

const LINKS = {
  REPO_URL,
  ISSUES_URL: `${REPO_URL}/issues`,
  README_URL: `${REPO_URL}#readme`,
  UPDATE_URL: `${REPO_URL}#updating`,
  RELEASE_TAG_URL: `${REPO_URL}/releases/tag/`,
  RELEASES_API_URL: 'https://api.github.com/repos/KrisMakes/OctoFarm-Redux/releases',
  KOFI_URL: 'https://ko-fi.com/krismakes',
};

module.exports = { LINKS, REPO_URL };
