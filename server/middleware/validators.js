const nodeInputValidator = require('node-input-validator');
const { ValidationException } = require('../exceptions/runtime.exceptions');
const { databaseNamesList } = require('../constants/database.constants');
const mongoose = require('mongoose');
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');
const Logger = require('../handlers/logger');
const path = require('path');
const logger = new Logger(LOGGER_ROUTE_KEYS.MIDDLEWARE_VALIDATION);

const errorMessage = (req) => {
  return `Invalid body input detected in ${req.protocol}://${req.get('host')}${req.originalUrl}`;
};

function validateMongoURL(mongoURL) {
  const mongoString = String(mongoURL).toLowerCase();
  const hasMongoPrefix =
    mongoString.includes('mongodb://') || mongoString.includes('mongodb+srv://');

  // const hasOctoFarmTable = mongoString.includes("/octofarm");
  // this should not be a validation rule on mongo... people can call their database whatever they like!
  return {
    hasMongoPrefix,
    isValid: hasMongoPrefix,
  };
}
//REFACTOR this needs splitting up for each section of the app
// Registered once at module load. getExtendedValidator() used to run all five
// nodeInputValidator.extend() calls against the module-level singleton on every
// single validated request.
let rulesRegistered = false;

function getExtendedValidator() {
  if (rulesRegistered) {
    return nodeInputValidator;
  }
  rulesRegistered = true;

  nodeInputValidator.extend('wss_url', ({ value }) => {
    try {
      const url = new URL(value).href;
      return url.startsWith('ws://') || url.startsWith('wss://');
    } catch (e) {
      // new URL throws on anything that is not a URL at all.
      return false;
    }
  });
  nodeInputValidator.extend('mongoose_object_id', async ({ value }) => {
    // Was `isValid(value) || typeof value !== "undefined"`, whose second clause
    // is true for every defined value -- so this validated nothing at all on
    // the ~15 routes that use it.
    return mongoose.Types.ObjectId.isValid(value);
  });
  //FIX this needs a custom message passing back out, can remove the logger then.
  nodeInputValidator.extend('settings_appearance', async ({ value, args }) => {
    const { color, colorTransparent, defaultLanguage, name, showFahrenheitAlso } = value;
    const colorValid = typeof color === 'string' && color === 'default'; //The client will always send default for adding a printer
    const colorTransparentValid =
      typeof colorTransparent === 'boolean' && colorTransparent === false;
    const defaultLanguageValid =
      typeof defaultLanguage === 'string' && defaultLanguage === '_default';
    const nameValid = typeof name === 'string' && name.length < 50; // Can be blank, must be less than 50 characters
    const showFahrenheitAlsoValid = typeof showFahrenheitAlso === 'boolean';

    logger.debug('settings_appearance validation', {
      colorValid,
      colorTransparentValid,
      defaultLanguageValid,
      nameValid,
      showFahrenheitAlsoValid,
    });

    return ![
      colorValid,
      colorTransparentValid,
      defaultLanguageValid,
      nameValid,
      showFahrenheitAlsoValid,
    ].includes(false);
  });
  nodeInputValidator.extend('database_name', async ({ value, args }) => {
    return databaseNamesList.includes(value);
  });
  nodeInputValidator.extend('system_path', async ({ value, args }) => {
    return value !== path.basename(value);
  });

  return nodeInputValidator;
}

async function validateInput(data, rules) {
  const localNIV = getExtendedValidator();

  const v = new localNIV.Validator(data, rules);

  const matched = await v.check();

  if (!matched) {
    throw new ValidationException(v.errors);
  }

  return v.inputs;
}

/**
 * Handle API input validation
 * @param rules
 * @returns {function(*, *, *): *}
 */
function validateBodyMiddleware(rules) {
  return function (req, res, next) {
    validateInput(req.body, rules)
      .then(() => {
        logger.debug('Validated Body Middleware');
        return next();
      })
      .catch((e) => {
        dealWithError(e, req, res);
      });
  };
}

function dealWithError(e, req, res) {
  logger.error(errorMessage(req), e?.errors ?? e?.message ?? String(e));
  // res.statusMessage = e put an exception object into the HTTP status line.
  // Send the field errors, not the validator's internals.
  return res.status(400).send({
    message: 'Invalid request',
    errors: e?.errors ?? undefined,
  });
}

function validateParamsMiddleware(rules) {
  return function (req, res, next) {
    validateInput(req.params, rules)
      .then(() => {
        logger.debug('Validated Params Middleware');
        return next();
      })
      .catch((e) => {
        dealWithError(e, req, res);
      });
  };
}

module.exports = {
  validateBodyMiddleware,
  validateParamsMiddleware,
  validateInput,
  validateMongoURL,
};
