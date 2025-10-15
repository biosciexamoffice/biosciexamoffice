import jwt from 'jsonwebtoken';
import User from '../models/user.js';

export const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user || user.status !== 'active') {
      return res.status(401).json({ success: false, message: 'User inactive or not found.' });
    }

    req.user = {
      id: user._id,
      email: user.email,
      pfNo: user.pfNo,
      roles: user.roles,
      collegeId: user.collegeId ? user.collegeId.toString() : null,
      departmentId: user.departmentId ? user.departmentId.toString() : null,
    };
    next();
  } catch (err) {
    console.error('Authentication error:', err);
    res.status(401).json({ success: false, message: 'Invalid or expired token.' });
  }
};

export const requireRoles = (...allowedRoles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }

  const hasRole = req.user.roles.some((role) => allowedRoles.includes(role));
  if (!hasRole) {
    return res.status(403).json({ success: false, message: 'You do not have permission to perform this action.' });
  }
  next();
};
