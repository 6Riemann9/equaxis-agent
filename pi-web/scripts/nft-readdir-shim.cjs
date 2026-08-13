// Build-environment shim for Windows: @vercel/nft traces pi-coding-agent's
// `join(homedir(), ...)` by globbing the entire user home. Junction entries
// (C:\Users\<name>\Cookies, "Application Data", AppData\Local\ElevatedDiagnostics, ...)
// make fs.readdir/readlink EPERM, which aborts `next build`.
//
// The home dir is never a real trace source for the `next start` runtime — it
// reads home config at runtime, not from the trace — so any glob rooted under
// the user home is short-circuited to empty. Unreadable/non-directory paths
// elsewhere are also treated as empty.
const fs = require("fs");
const os = require("os");

const home = os.homedir().replace(/\\/g, "/").toLowerCase();
const SWALLOWABLE = new Set(["EPERM", "EACCES", "ENOENT", "ENOTDIR"]);

function underHome(path) {
  return typeof path === "string" && path.replace(/\\/g, "/").toLowerCase().startsWith(home);
}

const origReaddir = fs.readdir;
fs.readdir = function (path, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  if (underHome(path)) {
    callback(null, []);
    return;
  }
  const done = (error, files) => {
    if (error && SWALLOWABLE.has(error.code)) {
      callback(null, []);
      return;
    }
    callback(error, files);
  };
  try {
    return origReaddir.call(this, path, options, done);
  } catch (error) {
    done(error, []);
  }
};

const origReaddirSync = fs.readdirSync;
fs.readdirSync = function (path, ...rest) {
  if (underHome(path)) return [];
  try {
    return origReaddirSync.call(this, path, ...rest);
  } catch (error) {
    if (SWALLOWABLE.has(error.code)) return [];
    throw error;
  }
};

const origReadlink = fs.readlink;
fs.readlink = function (path, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  const done = (error, value) => {
    if (error && SWALLOWABLE.has(error.code)) {
      callback(null, "");
      return;
    }
    callback(error, value);
  };
  try {
    return origReadlink.call(this, path, options, done);
  } catch (error) {
    done(error, "");
  }
};
