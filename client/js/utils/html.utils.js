/**
 * Escape a value for interpolation into HTML.
 *
 * Several of the UI's dialog and notification helpers take HTML rather than
 * text: bootbox renders `message` and `title` with jQuery's `.html()`, and
 * `UI.createAlert` hands its message to Noty the same way. That is deliberate
 * on bootbox's side - the maintainer declined to escape it, because HTML in
 * messages has always been part of the API (bootboxjs/bootbox#661, the subject
 * of CVE-2023-46998). There is no patched bootbox release, so escaping is the
 * caller's job.
 *
 * Use this on anything that did not come from our own source: gcode file and
 * folder paths, printer names, spool labels, and strings relayed from an
 * OctoPrint instance.
 */
export const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])
  );
