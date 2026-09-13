import { parse } from 'flatted';

/**
 * Parse an SSE payload, or false when it will not parse.
 *
 * Was `asyncParse`, marked async while doing nothing asynchronous -- a promise
 * allocation and a microtask per frame, on a stream that ticks every second.
 * Callers must check for `false` before destructuring the result.
 */
export const parsePayload = function (str) {
  try {
    return parse(str);
  } catch (e) {
    console.error('Could not parse an SSE payload', e);
    return false;
  }
};

export const debounce = function (func, wait) {
  let timeout;
  // Resolved once, not re-tested on every call into a shared outer binding.
  const waitFunc = typeof wait === 'function' ? wait : () => wait;
  return function () {
    const context = this,
      args = arguments;
    const later = function () {
      timeout = null;
      func.apply(context, args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, waitFunc());
  };
};
