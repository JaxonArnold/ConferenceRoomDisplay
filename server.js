const express = require('express');
const path = require('path');

// Try to load environment variables from .env file
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (e) {
  // dotenv is optional, continue without it
}

const app = express();
app.disable('x-powered-by');
const PORT = process.env.PORT || 8080;

const { TokenManager, DAYLITE_API, REQUEST_TIMEOUT_MS } = require('./tokenManager');

const LARGE_ROOM_RESOURCE = '/v1/resources/2015';
// Every display polls every 30 seconds; share one Daylite lookup between them
const CACHE_MS = 20 * 1000;

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

    const server = app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log('Token will auto-refresh before expiry');
    });
    server.on('error', error => {
      if (error.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. The server may already be running in the background (check with "npm run status").`);
      } else {
        console.error('Server error:', error);
      }
      process.exit(1);
    });
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
}

startServer();
