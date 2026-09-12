// node-fetch is ESM only from version 3, and this codebase is CommonJS, so it
// has to be imported dynamically. Every call site either awaits the result or
// chains .then() on it, so handing back a promise changes nothing for them.
//
// Node has had a global fetch since 18, but it is not a drop-in replacement
// here: its response body is a web ReadableStream, and download.util.js pipes
// the body straight into a file stream. node-fetch still gives a Node stream.
let modulePromise;

module.exports = async function fetch(...args) {
  if (!modulePromise) {
    modulePromise = import('node-fetch');
  }
  const { default: nodeFetch } = await modulePromise;
  return nodeFetch(...args);
};
