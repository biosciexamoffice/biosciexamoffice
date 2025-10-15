import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import User from '../models/user.js';

const ensureGoogleEnv = () =>
  Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_CALLBACK_URL);

const configurePassport = (passport) => {
  if (!ensureGoogleEnv()) {
    console.warn('Google OAuth credentials not provided. Google login disabled.');
    return;
  }

  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL,
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const email = profile?.emails?.[0]?.value?.toLowerCase();
          if (!email) {
            return done(null, false, { message: 'Google account does not expose an email address.' });
          }

          const user = await User.findOne({ email });
          if (!user) {
            return done(null, false, { message: 'Account not provisioned. Contact administrator.' });
          }

          if (user.status !== 'active') {
            return done(null, false, { message: 'Account is inactive.' });
          }

          done(null, user);
        } catch (error) {
          done(error);
        }
      }
    )
  );

  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id, done) => {
    try {
      const user = await User.findById(id);
      done(null, user);
    } catch (error) {
      done(error);
    }
  });
};

export default configurePassport;
