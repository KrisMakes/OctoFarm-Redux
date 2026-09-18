export default {
  SKIPPED: 'skipped',
  LOADING: 'loading',
  // Noty (the toast library, see utils/ui.js's createAlert) only recognises
  // 'error' as a type -- anything else, including the Bootstrap-conventional
  // 'danger', silently falls through to its plain/grey default styling.
  ERROR: 'error',
  SUCCESS: 'success',
  WARNING: 'warning',
};
