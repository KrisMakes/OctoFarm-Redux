const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const passport = require('passport');
const ClientSettings = require('../models/ClientSettings.js');
const { AppConstants } = require('../constants/app.constants');
const { SettingsClean } = require('../services/settings-cleaner.service');
const ServerSettingsDB = require('../models/ServerSettings.js');

const User = require('../models/User.js');
const { UserTokenService } = require('../services/authentication/user-token.service');
const { ensureAuthenticated, ensureAdministrator } = require('../middleware/auth');
const {
  fetchUsers,
  createUser,
  deleteUser,
  resetPassword,
  editUser,
} = require('../services/users.service');
const { validateParamsMiddleware } = require('../middleware/validators');
const { authenticationLimits } = require('../middleware/rate-limiting');
const M_VALID = require('../constants/validate-mongo.constants');
const { LOGGER_ROUTE_KEYS } = require('../constants/logger.constants');
const Logger = require('../handlers/logger');
const logger = new Logger(LOGGER_ROUTE_KEYS.ROUTE_USERS);

// Login Page
router.get('/login', async (_req, res) => {
  const serverSettings = SettingsClean.returnSystemSettings();
  res.render('login', {
    page: 'Login',
    octoFarmPageTitle: process.env[AppConstants.OCTOFARM_SITE_TITLE_KEY],
    registration: serverSettings.server.registration,
    serverSettings: serverSettings,
  });
});

// Login Handle
router.post(
  '/login',
  authenticationLimits,
  passport.authenticate('local', {
    // Dont add or we wont reach remember_me cookie successRedirect: "/dashboard",
    failureRedirect: '/users/login',
    failureFlash: true,
  }),
  async function (req, res, next) {
    // Carry only what has to survive the new session id. Object.assign-ing the
    // whole previous session back over the regenerated one -- including its id
    // and cookie -- reinstated exactly the fixation vector regenerate() exists
    // to close.
    const carriedOver = {
      passport: req.session.passport,
      flash: req.session.flash,
    };
    // regenerate() is asynchronous against the Mongo session store. This used to log
    // an error unconditionally (err is null on success) and carry on without waiting,
    // so the restored login state raced the redirect. Wait for it, and only log a
    // real failure.
    await new Promise((resolve) => {
      req.session.regenerate((err) => {
        if (err) {
          logger.error('Unable to regenerate session!', err);
        }
        for (const [key, value] of Object.entries(carriedOver)) {
          if (value !== undefined) {
            req.session[key] = value;
          }
        }
        resolve();
      });
    });

    if (!req.body.remember_me) {
      return next();
    }
    await UserTokenService.issueTokenWithDone(req.user, function (err, token) {
      if (err) {
        return next(err);
      }

      res.cookie('remember_me', token, {
        path: '/',
        httpOnly: true,
        maxAge: 604800000,
      });
      return next();
    });
  },
  (_req, res) => {
    res.redirect('/dashboard');
  }
);

// Register Page
router.get('/register', async (_req, res) => {
  const serverSettings = SettingsClean.returnSystemSettings();
  if (serverSettings.server.registration !== true) {
    return res.redirect('login');
  }

  let currentUsers = await fetchUsers();
  res.render('register', {
    page: 'Register',
    octoFarmPageTitle: process.env[AppConstants.OCTOFARM_SITE_TITLE_KEY],
    serverSettings: serverSettings,
    userCount: currentUsers.length,
  });
});

// Register Handle
router.post('/register', authenticationLimits, async (req, res) => {
  const name = req.bodyString('name');
  const username = req.bodyString('username');
  const password = req.bodyString('password');
  const password2 = req.bodyString('password2');

  const errors = [];

  const serverSettings = SettingsClean.returnSystemSettings();

  // The GET handler redirects away when registration is off, but this one never
  // checked, so a direct POST created an account regardless of the setting.
  if (serverSettings.server.registration !== true) {
    return res.redirect('login');
  }
  let currentUsers = await fetchUsers(true);

  // Check required fields
  if (!name || !username || !password || !password2) {
    errors.push({ msg: 'Please fill in all fields...' });
  }

  // Check passwords match
  if (password !== password2) {
    errors.push({ msg: 'Passwords do not match...' });
  }

  // Password at least 6 characters. Guarded: password can be null here, and
  // the missing-fields check above only records an error, it does not return.
  if (!password || password.length < 6) {
    errors.push({ msg: 'Password should be at least 6 characters...' });
  }

  if (errors.length > 0) {
    res.render('register', {
      page: 'Login',
      octoFarmPageTitle: process.env[AppConstants.OCTOFARM_SITE_TITLE_KEY],
      registration: serverSettings.server.registration,
      serverSettings: serverSettings,
      errors,
      name,
      username,
      userCount: currentUsers.length,
    });
  } else {
    // Validation Passed
    User.findOne({ username }).then((currentUser) => {
      if (currentUser) {
        // User exists
        errors.push({ msg: 'Username is already registered' });
        res.render('register', {
          page: 'Login',
          octoFarmPageTitle: process.env[AppConstants.OCTOFARM_SITE_TITLE_KEY],
          registration: serverSettings.server.registration,
          serverSettings: serverSettings,
          errors,
          name,
          username,
          userCount: currentUsers.length,
        });
      } else {
        // Check if first user that's created.
        User.find({}).then(async (userList) => {
          let userGroup;
          if (userList.length < 1) {
            userGroup = 'Administrator';
          } else {
            userGroup = 'User';
          }
          const userSettings = new ClientSettings();
          await userSettings.save();
          await SettingsClean.start();
          const newUser = new User({
            name,
            username,
            password,
            group: userGroup,
            clientSettings: userSettings._id,
          });
          // Hash Password
          bcrypt.genSalt(10, (error, salt) =>
            bcrypt.hash(newUser.password, salt, (err, hash) => {
              if (err) {
                // Throwing here is an uncaught exception, which kills the
                // process -- uncaughtException is deliberately left on Node's
                // default. Answer the request instead.
                logger.error('Unable to generate bcrypt hash', err);
                req.flash('error_msg', 'Could not create your account, please try again');
                return res.redirect('/users/register');
              }
              // Set password to hashed
              newUser.password = hash;
              // Save new User
              newUser
                .save()
                .then(async () => {
                  if (userList.length < 1) {
                    const currentSettings = await ServerSettingsDB.find({});
                    currentSettings[0].server.registration = false;
                    currentSettings[0].markModified('server.registration');
                    currentSettings[0].save();
                    await SettingsClean.start();
                  }
                  req.flash('success_msg', 'You are now registered and can login');
                  res.redirect('/users/login');
                })
                .catch((theError) => {
                  logger.error("Couldn't save user to database!", theError);
                })
                .finally(async () => {
                  await fetchUsers(true);
                });
            })
          );
        });
      }
    });
  }
});

// Logout Handle
router.get('/logout', (req, res, next) => {
  // passport 0.6 made logout asynchronous; the callback is required.
  req.logout((err) => {
    if (err) {
      return next(err);
    }
    req.flash('success_msg', 'You are logged out');
    res.redirect('/users/login');
  });
});

// Get user list
router.get(
  '/users/:id',
  ensureAuthenticated,
  ensureAdministrator,
  validateParamsMiddleware(M_VALID.MONGO_ID),
  async (req, res) => {
    // Never hand back the bcrypt hash or the remember-me token.
    const user = await User.findById(req.paramString('id'), '-password -loginToken -apiKey').lean();
    if (!user) {
      return res.sendStatus(404);
    }
    res.send(user);
  }
);

// Update user
router.patch(
  '/users/:id',
  ensureAuthenticated,
  ensureAdministrator,
  validateParamsMiddleware(M_VALID.MONGO_ID),
  async (req, res) => {
    const id = req.paramString('id');
    // This object literal always had all five keys, and `"password" in obj`
    // tests key presence rather than value -- so the reset branch ran on every
    // request, the edit branch was unreachable, and editing a user's name
    // blanked their password. Build from what was actually sent.
    const password = req.bodyString('password');
    const username = req.bodyString('username');

    if (password) {
      return res.send(
        await resetPassword(id, { password, password2: req.bodyString('password2') })
      );
    }

    if (username) {
      return res.send(
        await editUser(id, {
          name: req.bodyString('name'),
          username,
          group: req.bodyString('group'),
        })
      );
    }

    res.status(400).send({ message: 'Provide either a password or a username to change' });
  }
);

// New user
router.post('/users', ensureAuthenticated, ensureAdministrator, async (req, res) => {
  // Pick the fields rather than handing the whole body to the model.
  const user = {
    name: req.bodyString('name'),
    username: req.bodyString('username'),
    password: req.bodyString('password'),
    password2: req.bodyString('password2'),
    group: req.bodyString('group'),
  };
  if (!user.name || !user.username || !user.password) {
    return res.status(400).send({ message: 'Name, username and password are required' });
  }
  res.send(await createUser(user));
});

// Delete User
router.delete(
  '/users/:id',
  ensureAuthenticated,
  ensureAdministrator,
  validateParamsMiddleware(M_VALID.MONGO_ID),
  async (req, res) => {
    const id = req.paramString('id');
    res.send(await deleteUser(id));
  }
);

module.exports = router;
