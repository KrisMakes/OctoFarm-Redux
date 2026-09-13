// jplist is the only library here that genuinely has to be a global: the EJS
// templates drive it through data-jplist-* attributes and several client files
// call `jplist.init()` without importing it. Its UMD sets window.jplist as a
// side effect of being imported.
//
// Everything else that used to be in this bundle -- ApexCharts, GridStack,
// lodash, Noty, Sortable -- is imported directly by the page code that needs
// it, so shipping it here as well meant downloading it twice on every page:
// once in vendor.js (835KB, loaded by layout.ejs everywhere) and again inside
// each page runner. The `module.export` line that used to sit at the bottom was
// a typo for module.exports, so the object it built was never read by anything
// either way.
import './jplist.min';
