const express = require('express');
const path = require('path');
const fs = require('fs').promises;

// Try to load environment variables from .env file
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (e) {
  // dotenv is optional, continue without it
}

const app = express();
app.disable('x-powered-by');
const PORT = process.env.PORT || 8080;

const DAYLITE_API = process.env.DAYLITE_API_BASE || 'https://api.marketcircle.net';
const LARGE_ROOM_RESOURCE = '/v1/resources/2015';
const REQUEST_TIMEOUT_MS = 15 * 1000;
// Every display polls every 30 seconds; share one Daylite lookup between them
const CACHE_MS = 20 * 1000;

// Token management
class TokenManager {
  constructor() {
    this.tokenFile = path.join(__dirname, 'tokens.json');
    this.accessToken = null;
    this.refreshToken = process.env.DAYLITE_REFRESH_TOKEN || null;
    this.tokenExpiry = null;
    this.refreshPromise = null;
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
      throw new Error('No tokens available. Please provide DAYLITE_ACCESS_TOKEN or DAYLITE_REFRESH_TOKEN in environment variables');
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
      this.refreshPromise = this.doRefresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  async doRefresh() {
    if (!this.refreshToken) {
      throw new Error('No refresh token available');
    }

    console.log('Refreshing access token...');

    try {
      // Daylite personal token refresh endpoint (token provided in querystring)
      const tokenUrl = `${DAYLITE_API}/v1/personal_token/refresh_token?refresh_token=${encodeURIComponent(this.refreshToken)}`;

      const response = await fetch(tokenUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to refresh token: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      const accessToken = data.access_token || data.token;
      if (!accessToken) {
        throw new Error('Token refresh response did not include an access token');
      }

      this.accessToken = accessToken;
      this.refreshToken = data.refresh_token || this.refreshToken; // Update refresh token if provided

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

// Initialize token manager
const tokenManager = new TokenManager();

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Serve index.html from project root at '/'
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// API endpoint to get current/upcoming appointments
app.get('/api/appointments', async (req, res) => {
  try {
    const appointments = await getCachedAppointments();
    res.json(filterRelevantAppointments(appointments));
  } catch (error) {
    console.error('Error fetching appointments:', error.message);
    res.status(500).json({ error: 'Failed to fetch appointments' });
  }
});

let appointmentCache = { fetchedAt: 0, data: null };
let pendingFetch = null;

// Return recently fetched appointments, or fetch once for all waiting displays
function getCachedAppointments() {
  if (appointmentCache.data && Date.now() - appointmentCache.fetchedAt < CACHE_MS) {
    return Promise.resolve(appointmentCache.data);
  }
  if (!pendingFetch) {
    pendingFetch = fetchAppointmentsWithRetry()
      .then(data => {
        appointmentCache = { fetchedAt: Date.now(), data };
        return data;
      })
      .finally(() => {
        pendingFetch = null;
      });
  }
  return pendingFetch;
}

async function fetchAppointmentsWithRetry() {
  try {
    return await getUpcomingAppointments();
  } catch (error) {
    // If it's an auth error, refresh the token and try once more
    if (error.status !== 401) throw error;
    await tokenManager.refreshAccessToken();
    return getUpcomingAppointments();
  }
}

// Function to make authenticated API calls
async function authenticatedFetch(url, options = {}) {
  const token = await tokenManager.getValidToken();

  const fetchOptions = {
    ...options,
    headers: {
      ...options.headers,
      Authorization: token
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  };

  const response = await fetch(url, fetchOptions);

  if (!response.ok) {
    const error = new Error(`Daylite request failed: ${response.status} ${url}`);
    error.status = response.status;
    throw error;
  }

  return response;
}

// Function to get in-progress and soon-starting appointments from Daylite API
async function getUpcomingAppointments() {
  // Search a window around the current time rather than the UTC calendar day,
  // which ends mid-afternoon/evening in US time zones and hid later meetings.
  const now = Date.now();
  const windowStart = new Date(now - 24 * 60 * 60 * 1000);
  const windowEnd = new Date(now + 24 * 60 * 60 * 1000);

  const url = `${DAYLITE_API}/v1/appointments/_search?limit=500&full-records=true`;

  const options = {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      utc_start: { greater_than: windowStart.toISOString() },
      utc_end: { less_than: windowEnd.toISOString() },
      resources: { contains: 'Conference' }
    })
  };

  const res = await authenticatedFetch(url, options);
  const data = await res.json();
  const results = Array.isArray(data.results) ? data.results : [];

  // Only look up contacts for meetings that will actually be displayed
  const relevant = results
    .map(appt => ({ appt, start: new Date(appt.utc_start), end: new Date(appt.utc_end) }))
    .filter(({ start, end }) => isRelevant(start, end, new Date()));

  return Promise.all(relevant.map(async ({ appt, start, end }) => {
    // Determine which conference room
    const resources = Array.isArray(appt.resources) ? appt.resources : [];
    const room = resources.includes(LARGE_ROOM_RESOURCE) ? 'Large' : 'Small';

    return {
      start,
      end,
      names: await getContactFirstNames(appt.contacts),
      room
    };
  }));
}

// Get contact first names, skipping any contact that can't be loaded
async function getContactFirstNames(contacts) {
  if (!Array.isArray(contacts)) return [];

  const names = await Promise.all(contacts.map(async c => {
    if (!c || !c.contact) return null;
    try {
      const contactRes = await authenticatedFetch(`${DAYLITE_API}${c.contact}`, {
        headers: { Accept: 'application/json' }
      });
      const contactData = await contactRes.json();
      return contactData.first_name || null;
    } catch (error) {
      if (error.status === 401) throw error;
      console.error(`Could not load contact ${c.contact}:`, error.message);
      return null;
    }
  }));

  return names.filter(Boolean);
}

// Show if the meeting starts within the next 30 minutes or is in progress
function isRelevant(startTime, endTime, now) {
  const thirtyMinutesFromNow = new Date(now.getTime() + 30 * 60 * 1000);
  const startsWithin30Min = startTime > now && startTime <= thirtyMinutesFromNow;
  const currentlyInProgress = startTime <= now && endTime > now;
  return startsWithin30Min || currentlyInProgress;
}

// Filter appointments to only show those starting within 30 minutes or currently in progress
function filterRelevantAppointments(appointments) {
  const now = new Date();

  return appointments.filter(appt => isRelevant(appt.start, appt.end, now)).map(appt => {
    const startTime = appt.start;
    const endTime = appt.end;

    // Calculate minutes until start or if it's in progress
    let status;
    let minutesUntilStart;

    if (startTime <= now && endTime > now) {
      status = 'in-progress';
      minutesUntilStart = 0;
    } else {
      status = 'upcoming';
      minutesUntilStart = Math.round((startTime - now) / (1000 * 60));
    }

    return {
      ...appt,
      status,
      minutesUntilStart,
      formattedStartTime: startTime.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit'
      }),
      formattedEndTime: endTime.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit'
      })
    };
  });
}

// Initialize the app
async function startServer() {
  try {
    await tokenManager.initialize();

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log('Token will auto-refresh before expiry');
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
