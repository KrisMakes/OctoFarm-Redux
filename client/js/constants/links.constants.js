// Client-side copy of server/constants/links.constants.js - nothing under
// client/ imports from server/, so the fork URL is declared twice. Change both
// together. The upstream octofarm.net domains are dead (410, and the sponsor
// path is a parked domain), so nothing may link to them.

export const REPO_URL = 'https://github.com/DaniSim-Dev/OctoFarm-Redux';
export const ISSUES_URL = `${REPO_URL}/issues`;
export const README_URL = `${REPO_URL}#readme`;
