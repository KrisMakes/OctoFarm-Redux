const path = require('path');
const winston = require('winston');
const { AppConstants } = require('../constants/app.constants');
const { logRouteToFileMap, LOGGER_FILES } = require('../constants/logger.constants');

const dtFormat = new Intl.DateTimeFormat('en-GB', {
  timeStyle: 'medium',
  dateStyle: 'short',
  timeZone: 'UTC',
});

const ESC = '\u001b';
const COLOURS = {
  RESET: `${ESC}[0m`,
  RED: `${ESC}[0;31m`,
  YELLOW: `${ESC}[1;33m`,
  ORANGE: `${ESC}[0;33m`,
  BLUE: `${ESC}[0;34m`,
  PURPLE: `${ESC}[0;35m`,
  WHITE: `${ESC}[1;37m`,
  CYAN: `${ESC}[0;32m`,
};

const COLOUR_MAP = {
  info: COLOURS.BLUE,
  warn: COLOURS.ORANGE,
  verbose: COLOURS.CYAN,
  debug: COLOURS.ORANGE,
  error: COLOURS.RED,
  http: COLOURS.PURPLE,
  silly: COLOURS.CYAN,
};

const LEVELS = {
  error: 0,
  warn: 1,
  http: 2,
  info: 3,
  verbose: 4,
  debug: 5,
  silly: 6,
};

// Was an implicit global (`dateFormat = () => ...`), which pollutes globalThis
// and would throw under strict mode.
const dateFormat = () => dtFormat.format(new Date());

// Resolved against this file rather than process.cwd(): the old `../logs/...`
// only worked because pm2 happens to start from server/.
const LOG_DIRECTORY = path.join(__dirname, '..', '..', 'logs');

function formatMeta(meta) {
  if (meta === undefined || meta === null) {
    return undefined;
  }
  if (typeof meta === 'string' || typeof meta === 'number') {
    return meta;
  }
  try {
    return JSON.stringify(meta);
  } catch (e) {
    return String(meta);
  }
}

const plainFormat = winston.format.printf((info) => {
  const level = info.level.toUpperCase();
  const metaData = formatMeta(info.meta);
  const base = `${dateFormat()} | ${level} | ${info.route} \n ${level} MESSAGE: ${info.message} `;
  return metaData ? `${base}: ${metaData} ` : base;
});

const colourFormat = winston.format.printf((info) => {
  const level = info.level.toUpperCase();
  const colour = COLOUR_MAP[info.level] ?? COLOURS.WHITE;
  const metaData = formatMeta(info.meta);
  const base =
    `${colour}${dateFormat()} ${COLOURS.WHITE}| ${colour}${level} ${COLOURS.WHITE}| ` +
    `${colour}${info.route} ${COLOURS.WHITE} \n ${colour}${level} MESSAGE: ` +
    `${COLOURS.WHITE}${info.message}${COLOURS.RESET} `;
  return metaData ? `${base}| ${COLOURS.WHITE}${metaData}${COLOURS.RESET}` : base;
});

/**
 * One winston logger per log FILE, shared by every route that maps to it.
 *
 * Each `new Logger(route)` used to build a complete winston logger with its own
 * Console transport AND its own File transport. There are 66 of them and
 * logRouteToFileMap collapses those onto four filenames, so roughly forty
 * independent transports held descriptors on the same four files and could each
 * attempt a 5MB rotation concurrently.
 */
const loggersByFile = new Map();
let consoleTransport;

function getConsoleTransport(level) {
  if (!consoleTransport) {
    consoleTransport = new winston.transports.Console({
      level,
      format: colourFormat,
    });
  }
  return consoleTransport;
}

function getWinstonLogger(fileName, level, enableFileLogs) {
  const key = `${enableFileLogs ? fileName : 'console-only'}::${level}`;
  const existing = loggersByFile.get(key);
  if (existing) {
    return existing;
  }

  const logger = winston.createLogger({
    levels: LEVELS,
    transports: [
      getConsoleTransport(level),
      ...(enableFileLogs
        ? [
            new winston.transports.File({
              level,
              format: plainFormat,
              filename: path.join(LOG_DIRECTORY, `${fileName}.log`),
              maxsize: 5242880,
              maxFiles: 3,
            }),
          ]
        : []),
    ],
  });

  loggersByFile.set(key, logger);
  return logger;
}

class LoggerService {
  constructor(route, enableFileLogs = true, logFilterLevel = undefined) {
    const level = logFilterLevel || process.env[AppConstants.LOG_LEVEL] || 'info';
    this.route = route;
    // A route with no mapping used to produce "logs/undefined.log".
    const fileName = logRouteToFileMap[route] ?? LOGGER_FILES.SYSTEM;
    this.logger = getWinstonLogger(fileName, level, enableFileLogs);
  }

  #log(level, message, meta) {
    this.logger.log(level, message, { meta, route: this.route });
  }

  info(message, meta) {
    this.#log('info', message, meta);
  }

  warning(message, meta) {
    this.#log('warn', message, meta);
  }

  http(message, meta) {
    this.#log('http', message, meta);
  }

  verbose(message, meta) {
    this.#log('verbose', message, meta);
  }

  debug(message, meta) {
    this.#log('debug', message, meta);
  }

  error(message, meta) {
    this.#log('error', message, meta);
  }

  silly(message, meta) {
    this.#log('silly', message, meta);
  }
}

module.exports = LoggerService;
