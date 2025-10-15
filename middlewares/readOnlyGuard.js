import { isReadOnlyMode } from '../config/mongoDB.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const WHITELIST = [
  /^\/api\/auth\/?.*/,
  /^\/api\/env\/?.*/,
  /^\/api\/health\/?.*/,
];

const readOnlyGuard = (req, res, next) => {
  if (!isReadOnlyMode()) {
    return next();
  }

  if (!MUTATING_METHODS.has(req.method)) {
    return next();
  }

  const path = req.path || '';
  const isWhitelisted = WHITELIST.some((pattern) => pattern.test(path));
  if (isWhitelisted) {
    return next();
  }

  return res.status(403).json({
    success: false,
    message: 'Server is running in read-only mode. Please connect via the primary network to perform this action.',
  });
};

export default readOnlyGuard;
