const path = require('path');
const fs = require('fs').promises;

const DAYLITE_API = process.env.DAYLITE_API_BASE || 'https://api.marketcircle.net';
const TOKEN_FILE = path.join(__dirname, 'tokens.json');
const REQUEST_TIMEOUT_MS = 15 * 1000;
// After a failed refresh, wait before asking Daylite again
const REFRESH_RETRY_MS = 60 * 1000;

// Token management
class TokenManager {
  constructor() {
    this.tokenFile = TOKEN_FILE;
    this.accessToken = null;
    this.refreshToken = process.env.DAYLITE_REFRESH_TOKEN || null;
    this.tokenExpiry = null;
    this.refreshPromise = null;
    this.lastRefreshError = null;
    this.lastRefreshFailedAt = 0;
  }

  async initialize() {
    // Try to load existing tokens from file
    let tokens = null;
    try {
      tokens = JSON.parse(await fs.readFile(this.tokenFile, 'utf8'));
    } catch (error) {
      console.log(error.code === 'ENOENT'
        ? 'No existing token file found'
        : `Could not read token file: ${error.message}`);
    }

    if (tokens) {
      this.accessToken = tokens.accessToken;
      this.refreshToken = tokens.refreshToken || this.refreshToken;
      this.tokenExpiry = tokens.tokenExpiry ? new Date(tokens.tokenExpiry) : null;
      console.log('Loaded existing tokens from file');
    } else if (process.env.DAYLITE_ACCESS_TOKEN) {
      // If we have initial access token from env, use it
      this.accessToken = process.env.DAYLITE_ACCESS_TOKEN;
      // Assume it expires in 1 hour from now if not specified
      this.tokenExpiry = new Date(Date.now() + 60 * 60 * 1000);
      await this.saveTokens();
    }

    if (!this.accessToken && !this.refreshToken) {
      throw new Error('No Daylite tokens found. Run "npm run setup" to enter them.');
    }

    // A failed refresh here (e.g. network not up yet after a reboot) shouldn't
    // stop the server; it will be retried on the next appointments request.
    if (this.needsRefresh()) {
      try {
        await this.refreshAccessToken();
      } catch (error) {
        console.error('Initial token refresh failed, will retry on next request');
      }
    }
  }

  needsRefresh() {
    if (!this.tokenExpiry) return true;
    // Refresh if token expires in less than 5 minutes
    const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
    return this.tokenExpiry <= fiveMinutesFromNow;
  }

  // Concurrent callers share one in-flight refresh, so a refresh token is never
  // used twice (Daylite may invalidate it once it has been exchanged).
  refreshAccessToken() {
    if (!this.refreshPromise) {
      if (this.lastRefreshError && Date.now() - this.lastRefreshFailedAt < REFRESH_RETRY_MS) {
        return Promise.reject(this.lastRefreshError);
      }
      this.refreshPromise = this.doRefresh()
        .then(() => {
          this.lastRefreshError = null;
        }, error => {
          this.lastRefreshError = error;
          this.lastRefreshFailedAt = Date.now();
          throw error;
        })
        .finally(() => {
          this.refreshPromise = null;
        });
    }
    return this.refreshPromise;
  }

  async doRefresh() {
    try {
      await this.exchangeRefreshToken(this.refreshToken);
    } catch (error) {
      // tokens.json wins over .env, so new tokens typed into .env would never be
      // used. If the saved token is rejected, try the one in .env before giving up.
      const envToken = process.env.DAYLITE_REFRESH_TOKEN;
      if (!error.rejected || !envToken || envToken === this.refreshToken) {
        if (error.rejected) {
          console.error('Daylite rejected the refresh token. Run "npm run setup" to enter a new one.');
        }
        throw error;
      }
      console.log('Saved refresh token was rejected, trying the one in .env...');
      await this.exchangeRefreshToken(envToken);
    }
  }

  async exchangeRefreshToken(refreshToken) {
    if (!refreshToken) {
      throw new Error('No refresh token available. Run "npm run setup" to enter one.');
    }

    console.log('Refreshing access token...');

    try {
      // Daylite personal token refresh endpoint (token provided in querystring)
      const tokenUrl = `${DAYLITE_API}/v1/personal_token/refresh_token?refresh_token=${encodeURIComponent(refreshToken)}`;

      const response = await fetch(tokenUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });

      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(`Failed to refresh token: ${response.status} - ${errorText}`);
        // 400 invalid_grant / 401 mean the token itself is bad, not a network blip
        error.rejected = response.status === 400 || response.status === 401;
        throw error;
      }

      const data = await response.json();
      const accessToken = data.access_token || data.token;
      if (!accessToken) {
        throw new Error('Token refresh response did not include an access token');
      }

      this.accessToken = accessToken;
      this.refreshToken = data.refresh_token || refreshToken; // Update refresh token if provided

      // Calculate expiry time (typically 1 hour for Daylite)
      const expiresIn = data.expires_in || 3600; // Default to 1 hour
      this.tokenExpiry = new Date(Date.now() + expiresIn * 1000);

      await this.saveTokens();
      console.log('Access token refreshed successfully. Expires at:', this.tokenExpiry);

    } catch (error) {
      console.error('Error refreshing token:', error.message);
      throw error;
    }
  }

  async saveTokens() {
    const tokens = {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      tokenExpiry: this.tokenExpiry ? this.tokenExpiry.toISOString() : null
    };

    // Write to a temp file and rename so a crash mid-write can't corrupt the
    // only copy of the refresh token. Readable by the owner only.
    const tmpFile = `${this.tokenFile}.tmp`;
    await fs.writeFile(tmpFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    await fs.rename(tmpFile, this.tokenFile);
  }

  async getValidToken() {
    if (this.needsRefresh()) {
      await this.refreshAccessToken();
    }
    return `Bearer ${this.accessToken}`;
  }
}

module.exports = { TokenManager, DAYLITE_API, REQUEST_TIMEOUT_MS };
