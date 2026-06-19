function success(res, data, statusCode = 200) {
  return res.status(statusCode).json({ success: true, data });
}

function error(res, message, statusCode = 400) {
  return res.status(statusCode).json({ success: false, message });
}

module.exports = { success, error };
