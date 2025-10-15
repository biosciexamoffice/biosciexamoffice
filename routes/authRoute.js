import express from 'express';
import passport from 'passport';
import {
  login,
  bootstrapAdmin,
  createUser,
  listUsers,
  updateUserStatus,
  deleteUser,
  getCurrentUser,
  updateCurrentUserProfile,
  updateCurrentUserPassword,
  googleAuthSuccess,
  logoutSession,
} from '../controllers/authController.js';
import { authenticate, requireRoles } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.post('/login', login);
router.post('/bootstrap-admin', bootstrapAdmin);
router.get(
  '/google',
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account',
    session: false,
  })
);
router.get(
  '/google/callback',
  passport.authenticate('google', {
    failureRedirect: '/login?error=google',
    session: false,
  }),
  googleAuthSuccess
);

router.use(authenticate);

router.get('/me', getCurrentUser);
router.patch('/me', updateCurrentUserProfile);
router.patch('/me/password', updateCurrentUserPassword);
router.post('/logout', logoutSession);

router.get('/users', requireRoles('ADMIN'), listUsers);
router.post('/users', requireRoles('ADMIN'), createUser);
router.patch('/users/:userId', requireRoles('ADMIN'), updateUserStatus);
router.delete('/users/:userId', requireRoles('ADMIN'), deleteUser);

export default router;
