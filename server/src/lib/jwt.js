const jwt = require('jsonwebtoken');
function signToken(user){ return jwt.sign({ sub:String(user.id), username:user.username }, process.env.JWT_SECRET, { expiresIn:'30d' }); }
function verifyToken(token){ return jwt.verify(token, process.env.JWT_SECRET); }
module.exports = { signToken, verifyToken };
