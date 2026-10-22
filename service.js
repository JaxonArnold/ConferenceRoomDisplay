#!/usr/bin/env node

/**
 * Runs the display server in the background on macOS using launchd, so it
 * starts at login and restarts automatically if it crashes.
 *
 *   node service.js install    Install (or reinstall) and start the service
 *   node service.js uninstall  Stop and remove the service
 *   node service.js restart    Restart the running service
 *   node service.js status     Show whether the service is running
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LABEL = 'com.conferenceroomdisplay.server';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'server.log');
const DOMAIN = `gui/${process.getuid()}`;

function launchctl(args, { quiet = false } = {}) {
  try {
    return execFileSync('launchctl', args, { encoding: 'utf8', stdio: quiet ? 'pipe' : ['ignore', 'pipe', 'inherit'] });
  } catch (error) {
    if (quiet) return null;
    throw error;
  }
}

function isInstalled() {
  return fs.existsSync(PLIST);
}

function escapeXml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function install() {
  if (process.platform !== 'darwin') {
    console.error('Background service setup only supports macOS.');
    process.exit(1);
  }

  // macOS privacy protection can stop background processes reading these folders
  const protectedDirs = ['Documents', 'Desktop', 'Downloads'].map(d => path.join(os.homedir(), d) + path.sep);
  if (protectedDirs.some(dir => __dirname.startsWith(dir))) {
    console.warn('⚠️  This project is inside Documents, Desktop or Downloads.');
    console.warn('   macOS may block the background service from reading it. If the');
    console.warn(`   service won't start, move the folder (e.g. to ${path.join(os.homedir(), 'ConferenceRoomDisplay')})`);
    console.warn('   and run "npm run install-service" again.\n');
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(path.join(__dirname, 'server.js'))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(__dirname)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(LOG_FILE)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(LOG_FILE)}</string>
</dict>
</plist>
`;

  // Replace any previous version of the service
  launchctl(['bootout', `${DOMAIN}/${LABEL}`], { quiet: true });
  fs.writeFileSync(PLIST, plist);
  launchctl(['bootstrap', DOMAIN, PLIST]);

  console.log('✅ Server installed as a background service.');
  console.log('   It starts automatically when this Mac logs in and restarts if it crashes.');
  console.log(`   Logs: ${LOG_FILE}  (view with "npm run logs")`);
}

function uninstall() {
  launchctl(['bootout', `${DOMAIN}/${LABEL}`], { quiet: true });
  if (isInstalled()) fs.unlinkSync(PLIST);
  console.log('Background service removed.');
}

function restart() {
  if (!isInstalled()) {
    console.error('The background service is not installed. Run "npm run install-service".');
    process.exit(1);
  }
  launchctl(['kickstart', '-k', `${DOMAIN}/${LABEL}`]);
  console.log('Server restarted.');
}

function status() {
  if (!isInstalled()) {
    console.log('Background service: not installed (run "npm run install-service")');
    return;
  }
  const info = launchctl(['print', `${DOMAIN}/${LABEL}`], { quiet: true });
  const state = info && info.match(/^\s*state = (.+)$/m);
  const pid = info && info.match(/^\s*pid = (\d+)$/m);
  console.log(`Background service: ${state ? state[1] : 'not loaded'}${pid ? ` (pid ${pid[1]})` : ''}`);
  console.log(`Logs: ${LOG_FILE}`);
}

module.exports = { isInstalled, install, restart };

if (require.main === module) {
  const commands = { install, uninstall, restart, status };
  const command = commands[process.argv[2]];
  if (!command) {
    console.log('Usage: node service.js install|uninstall|restart|status');
    process.exit(1);
  }
  command();
}
