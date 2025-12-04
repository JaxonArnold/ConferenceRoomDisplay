const express = require('express');
const path = require('path');
const fs = require('fs').promises;

// Try to load environment variables from .env file
try {
  require('dotenv').config();
} catch (e) {
  // dotenv is optional, continue without it
}

const app = express();
const PORT = process.env.PORT || 8080;

// Token management
class TokenManager {
  constructor() {
    this.tokenFile = 'tokens.json';
    this.accessToken = null;
    this.refreshToken = process.env.DAYLITE_REFRESH_TOKEN || null;
    this.tokenExpiry = null;
  }

  async initialize() {
    // Try to load existing tokens from file
    try {
      const data = await fs.readFile(this.tokenFile, 'utf8');
      const tokens = JSON.parse(data);
      this.accessToken = tokens.accessToken;
      this.refreshToken = tokens.refreshToken || this.refreshToken;
      this.tokenExpiry = tokens.tokenExpiry ? new Date(tokens.tokenExpiry) : null;
      
      console.log('Loaded existing tokens from file');
      
      // Check if token needs refresh
      if (this.needsRefresh()) {
        await this.refreshAccessToken();
      }
    } catch (error) {
      console.log('No existing token file found or error reading it');
      
      // If we have initial access token from env, use it
      if (process.env.DAYLITE_ACCESS_TOKEN) {
        this.accessToken = process.env.DAYLITE_ACCESS_TOKEN;
        // Assume it expires in 1 hour from now if not specified
        this.tokenExpiry = new Date(Date.now() + 60 * 60 * 1000);
        await this.saveTokens();
      } else if (this.refreshToken) {
        // If we only have refresh token, get new access token
        await this.refreshAccessToken();
      } else {
        throw new Error('No tokens available. Please provide DAYLITE_ACCESS_TOKEN or DAYLITE_REFRESH_TOKEN in environment variables');
      }
    }
  }

  needsRefresh() {
    if (!this.tokenExpiry) return true;
    // Refresh if token expires in less than 5 minutes
    const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
    return this.tokenExpiry <= fiveMinutesFromNow;
  }

  async refreshAccessToken() {
    if (!this.refreshToken) {
      throw new Error('No refresh token available');
    }

    console.log('Refreshing access token...');
    
    try {
      // Daylite OAuth2 token refresh endpoint
  // Use the instance's refresh token and URL-encode it to be safe
  const tokenUrl = `https://api.marketcircle.net/v1/personal_token/refresh_token?refresh_token=${encodeURIComponent(this.refreshToken)}`;

      // Use GET for the refresh endpoint (token provided in querystring).
      const response = await fetch(tokenUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to refresh token: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      
      this.accessToken = data.access_token || data.token;
      this.refreshToken = data.refresh_token || this.refreshToken; // Update refresh token if provided
      
      // Calculate expiry time (typically 1 hour for Daylite)
      const expiresIn = data.expires_in || 3600; // Default to 1 hour
      this.tokenExpiry = new Date(Date.now() + expiresIn * 1000);
      
      await this.saveTokens();
      console.log('Access token refreshed successfully. Expires at:', this.tokenExpiry);
      
    } catch (error) {
      console.error('Error refreshing token:', error);
      throw error;
    }
  }

  async saveTokens() {
    const tokens = {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      tokenExpiry: this.tokenExpiry ? this.tokenExpiry.toISOString() : null
    };
    
    await fs.writeFile(this.tokenFile, JSON.stringify(tokens, null, 2));
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
app.use(express.static('public'));
// Also serve project root files under /assets so images placed in repo root are reachable
app.use('/assets', express.static(path.join(__dirname)));

// Serve index.html from project root at '/'
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// API endpoint to get current/upcoming appointments
app.get('/api/appointments', async (req, res) => {
  try {
    const appointments = await getAppointmentsForToday();
    const relevantAppointments = filterRelevantAppointments(appointments);
    res.json(relevantAppointments);
  } catch (error) {
    console.error('Error fetching appointments:', error);
    
    // If it's an auth error, try refreshing token once more
    if (error.message && error.message.includes('401')) {
      try {
        await tokenManager.refreshAccessToken();
        const appointments = await getAppointmentsForToday();
        const relevantAppointments = filterRelevantAppointments(appointments);
        res.json(relevantAppointments);
        return;
      } catch (retryError) {
        console.error('Retry failed:', retryError);
      }
    }
    
    res.status(500).json({ error: 'Failed to fetch appointments' });
  }
});

// Function to make authenticated API calls
async function authenticatedFetch(url, options = {}) {
  const token = await tokenManager.getValidToken();
  
  const fetchOptions = {
    ...options,
    headers: {
      ...options.headers,
      Authorization: token
    }
  };
  
  const response = await fetch(url, fetchOptions);
  
  // Check for unauthorized response
  if (response.status === 401) {
    throw new Error('401 Unauthorized - Token may have expired');
  }
  
  return response;
}

// Function to get today's appointments from Daylite API
async function getAppointmentsForToday() {
  // Get today's date in UTC
  const today = new Date();
  const startOfDay = new Date(today);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const endOfDay = new Date(today);
  endOfDay.setUTCHours(23, 59, 59, 999);
  
  const url = 'https://api.marketcircle.net/v1/appointments/_search?limit=500&full-records=true';
  
  const options = {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      utc_start: { greater_than: startOfDay.toISOString() },
      utc_end: { less_than: endOfDay.toISOString() },
      resources: { contains: 'Conference' }
    })
  };
  
  const res = await authenticatedFetch(url, options);
  const data = await res.json();
  const results = data.results || [];
  
  const appointments = [];
  
  for (const appt of results) {
    const startTime = new Date(appt.utc_start);
    const endTime = new Date(appt.utc_end);
    
    // Determine which conference room
    let room;
    if (appt.resources.join() == '/v1/resources/2015') {
      room = 'Large';
    } else {
      room = 'Small';
    }
    
    // Get contact first names
    const contactFirstNames = [];
    if (Array.isArray(appt.contacts)) {
      for (const c of appt.contacts) {
        if (c.contact) {
          const contactUrl = `https://api.marketcircle.net${c.contact}`;
          const contactRes = await authenticatedFetch(contactUrl, {
            headers: { Accept: "application/json" }
          });
          const contactData = await contactRes.json();
          if (contactData.first_name) {
            contactFirstNames.push(contactData.first_name);
          }
        }
      }
    }
    
    appointments.push({
      start: startTime,
      end: endTime,
      names: contactFirstNames,
      room: room,
      title: appt.title || ''
    });
  }
  
  return appointments;
}

// Filter appointments to only show those starting within 30 minutes or currently in progress
function filterRelevantAppointments(appointments) {
  const now = new Date();
  const thirtyMinutesFromNow = new Date(now.getTime() + 30 * 60 * 1000);
  
  return appointments.filter(appt => {
    const startTime = new Date(appt.start);
    const endTime = new Date(appt.end);
    
    // Show if:
    // 1. Meeting starts within the next 30 minutes
    // 2. Meeting is currently in progress
    const startsWithin30Min = startTime > now && startTime <= thirtyMinutesFromNow;
    const currentlyInProgress = startTime <= now && endTime > now;
    
    return startsWithin30Min || currentlyInProgress;
  }).map(appt => {
    const startTime = new Date(appt.start);
    const endTime = new Date(appt.end);
    const now = new Date();
    
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
