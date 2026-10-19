// Splits an MJPEG stream back into the individual JPEGs it is made of.
//
// `multipart/x-mixed-replace` is a container, not a video codec: the stream is
// a boundary line, a few headers, one whole JPEG, repeat, forever. A browser
// pointed at it does this parsing itself, which is why the camera proxy can
// simply pipe the bytes through. The hub cannot -- it has to hand each viewer
// whole frames, so it has to find the frame edges.
//
// Written as a push parser over a reused buffer rather than concatenating: a
// chunk arrives every few milliseconds per camera, and `Buffer.concat` on a
// growing buffer copies the whole thing every time.
const MAX_HEADER_BYTES = 8 * 1024;
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const INITIAL_CAPACITY = 128 * 1024;

const CRLFCRLF = Buffer.from('\r\n\r\n');
const LFLF = Buffer.from('\n\n');

const SEEK_DELIMITER = 0;
const SEEK_HEADERS_END = 1;
const READ_BODY = 2;

const JPEG_SOI_0 = 0xff;
const JPEG_SOI_1 = 0xd8;

const DASH = 0x2d;
const CR = 0x0d;
const LF = 0x0a;

// The boundary as the server declares it in its content-type, which is not
// necessarily how it appears on the wire -- the wire form is always two dashes
// followed by the declared value, and some streamers declare a value that
// already starts with dashes. Stripping them is safe either way: `--` plus the
// stripped value is always a suffix of the real delimiter, so it still matches,
// just two bytes later.
const parseBoundary = (contentType) => {
  if (typeof contentType !== 'string') {
    return null;
  }
  const match = /boundary=(?:"([^"]+)"|([^;,\s]+))/i.exec(contentType);
  if (!match) {
    return null;
  }
  const declared = (match[1] || match[2] || '').trim().replace(/^-+/, '');
  return declared.length ? declared : null;
};

const contentLengthOf = (headerText) => {
  const match = /^content-length:[ \t]*(\d+)[ \t]*$/im.exec(headerText);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

// Whichever of the two blank-line forms comes first. Every camera worth
// supporting sends CRLF, but a stream that sends bare LF is otherwise
// perfectly parseable and there is no reason to refuse it.
const indexOfHeadersEnd = (view) => {
  const crlf = view.indexOf(CRLFCRLF);
  const lf = view.indexOf(LFLF);
  if (crlf === -1) {
    return lf === -1 ? { at: -1, length: 0 } : { at: lf, length: 2 };
  }
  if (lf === -1 || crlf < lf) {
    return { at: crlf, length: 4 };
  }
  return { at: lf, length: 2 };
};

class MjpegDemuxer {
  #delimiter;
  #onFrame;
  #onError;
  #maxFrameBytes;
  #buf;
  #start = 0;
  #end = 0;
  #state = SEEK_DELIMITER;
  #contentLength = null;
  #failed = false;

  // `onFrame` is handed a Buffer that it owns -- the parser's own storage is
  // reused for the next frame, so the bytes are copied out.
  constructor({ boundary, onFrame, onError, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES }) {
    if (!boundary) {
      throw new Error('MjpegDemuxer needs a boundary');
    }
    this.#delimiter = Buffer.from(`--${boundary}`);
    this.#onFrame = onFrame;
    this.#onError = onError;
    this.#maxFrameBytes = maxFrameBytes;
    this.#buf = Buffer.allocUnsafe(INITIAL_CAPACITY);
  }

  // Frames seen, and frames thrown away because they did not begin with a JPEG
  // start-of-image marker. A non-zero drop count means the parser lost the
  // frame edges, which is worth seeing in a log rather than silently showing
  // viewers nothing.
  frames = 0;
  dropped = 0;

  get stalled() {
    return this.#failed;
  }

  #view() {
    return this.#buf.subarray(this.#start, this.#end);
  }

  #fail(message) {
    if (this.#failed) {
      return;
    }
    this.#failed = true;
    this.#onError?.(new Error(message));
  }

  #append(chunk) {
    const used = this.#end - this.#start;
    // Slide what is left of a part-parsed frame back to the front before
    // reaching for more memory. In the steady state this is the only thing
    // that ever happens: a frame is parsed, nothing is left over, and the next
    // chunk lands at offset zero.
    if (this.#start > 0 && this.#buf.length - this.#end < chunk.length) {
      this.#buf.copy(this.#buf, 0, this.#start, this.#end);
      this.#start = 0;
      this.#end = used;
    }
    if (this.#buf.length - this.#end < chunk.length) {
      let capacity = this.#buf.length;
      while (capacity - this.#end < chunk.length) {
        capacity *= 2;
      }
      // A frame cannot be larger than the ceiling, so neither can the buffer
      // holding one, plus the headers in front of it.
      if (capacity > this.#maxFrameBytes + MAX_HEADER_BYTES) {
        this.#fail(`MJPEG stream wanted ${capacity} bytes of buffer`);
        return;
      }
      const grown = Buffer.allocUnsafe(capacity);
      this.#buf.copy(grown, 0, 0, this.#end);
      this.#buf = grown;
    }
    chunk.copy(this.#buf, this.#end);
    this.#end += chunk.length;
  }

  // Everything before `keep` bytes from the end is known not to contain the
  // start of a delimiter, so it can go.
  #discardAllBut(keep) {
    const used = this.#end - this.#start;
    if (used > keep) {
      this.#start += used - keep;
    }
  }

  #emit(frame) {
    // A frame that does not start with the JPEG marker means the frame edges
    // were lost -- a truncated Content-Length, or a boundary found inside a
    // body. Handing it to viewers paints a broken image; dropping it costs one
    // frame and the next boundary resynchronises.
    if (frame.length < 2 || frame[0] !== JPEG_SOI_0 || frame[1] !== JPEG_SOI_1) {
      this.dropped += 1;
      return;
    }
    this.frames += 1;
    this.#onFrame(frame);
  }

  push(chunk) {
    if (this.#failed) {
      return;
    }
    this.#append(chunk);
    if (this.#failed) {
      return;
    }
    this.#parse();
  }

  #parse() {
    for (;;) {
      if (this.#failed) {
        return;
      }
      const view = this.#view();

      if (this.#state === SEEK_DELIMITER) {
        const at = view.indexOf(this.#delimiter);
        if (at === -1) {
          // A delimiter split across two chunks must survive to be found.
          this.#discardAllBut(this.#delimiter.length - 1);
          return;
        }
        this.#start += at + this.#delimiter.length;
        this.#state = SEEK_HEADERS_END;
        continue;
      }

      if (this.#state === SEEK_HEADERS_END) {
        // `--boundary--` is the closing delimiter. Nothing follows it, and the
        // caller sees the stream end on its own.
        if (view.length >= 2 && view[0] === DASH && view[1] === DASH) {
          this.#start = this.#end;
          this.#state = SEEK_DELIMITER;
          return;
        }
        const { at, length } = indexOfHeadersEnd(view);
        if (at === -1) {
          if (view.length > MAX_HEADER_BYTES) {
            this.#fail('MJPEG part headers never ended');
          }
          return;
        }
        const headerText = view.subarray(0, at).toString('latin1');
        this.#start += at + length;
        this.#contentLength = contentLengthOf(headerText);
        if (this.#contentLength !== null && this.#contentLength > this.#maxFrameBytes) {
          this.#fail(`MJPEG frame declared ${this.#contentLength} bytes`);
          return;
        }
        this.#state = READ_BODY;
        continue;
      }

      // READ_BODY. Every camera on this farm sends Content-Length, which makes
      // the body length known and means no byte of JPEG is ever scanned for a
      // boundary it might legitimately contain. The scan below is the fallback
      // for one that does not, and it is strictly worse: a frame is only
      // complete once the boundary of the NEXT one arrives, so every frame is
      // delivered a frame late, and a JPEG that happens to contain the
      // boundary bytes is cut in half.
      if (this.#contentLength !== null) {
        if (view.length < this.#contentLength) {
          return;
        }
        const frame = Buffer.from(view.subarray(0, this.#contentLength));
        this.#start += this.#contentLength;
        this.#state = SEEK_DELIMITER;
        this.#contentLength = null;
        this.#emit(frame);
        continue;
      }

      const at = view.indexOf(this.#delimiter);
      if (at === -1) {
        if (view.length > this.#maxFrameBytes) {
          this.#fail('MJPEG frame grew past the ceiling with no boundary in sight');
        }
        return;
      }
      let bodyEnd = at;
      while (bodyEnd > 0 && (view[bodyEnd - 1] === LF || view[bodyEnd - 1] === CR)) {
        bodyEnd -= 1;
      }
      const frame = Buffer.from(view.subarray(0, bodyEnd));
      // The delimiter itself is left in place for SEEK_DELIMITER to consume,
      // so there is one place that knows how long it is.
      this.#start += at;
      this.#state = SEEK_DELIMITER;
      this.#emit(frame);
    }
  }
}

module.exports = {
  MjpegDemuxer,
  parseBoundary,
};
