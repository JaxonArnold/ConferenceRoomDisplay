# Conference Room Display App

 A web application that displays welcome messages for conference room meetings, pulling data from Daylite CRM.

## Setup

1. **Install Dependencies**
   ```bash
   npm install --omit=dev
   ```

2. **Enter your Daylite tokens**
   ```bash
   npm run setup
   ```
   Create a personal token in the Daylite API dashboard
   (https://developer.daylite.app/reference/personal-token) and paste the access and refresh
   tokens when asked. Setup checks them with Daylite right away and saves them to `tokens.json`.
   Run it again any time you need new tokens.

3. **Start the Server**

   At the end of setup, answer **Y** to run the server in the background. It then starts
   automatically when this Mac logs in and restarts if it crashes. To run it in the
   foreground instead, use `npm start`.

   | Command | What it does |
   | --- | --- |
   | `npm run status` | Show whether the background server is running |
   | `npm run restart` | Restart the background server |
   | `npm run logs` | Follow the server log |
   | `npm run install-service` | Install the background server without rerunning setup |
   | `npm run uninstall-service` | Stop and remove the background server |

   The Mac needs to log in automatically after a restart for the background server to start.
   If you update Node, run `npm run install-service` again.

4. **Access the Display**
   Open your browser to `http://localhost:8080`

## Token Management

The app includes automatic token management for Daylite's personal tokens:

- **Automatic Refresh**: Tokens are refreshed 5 minutes before expiry
- **Token Persistence**: Tokens are saved to `tokens.json` (gitignored)
- **Fallback Handling**: If a request fails with 401, the app attempts to refresh and retry
- **No Manual Intervention**: Once configured, tokens are managed automatically

### Token Refresh Endpoint

The app uses Daylite's personal token refresh endpoint:
```
GET https://api.marketcircle.net/v1/personal_token/refresh_token?refresh_token={refresh_token}
```

### Testing Token Refresh

To test if your refresh token is working:
```bash
npm run test-token
```

This will attempt to refresh your token and verify it works with the API.

### Token Flow

1. On startup, the app checks for existing tokens in `tokens.json`
2. If no saved tokens exist, it uses tokens from environment variables
3. Before each API call, it checks if the token needs refresh
4. Tokens are refreshed automatically when needed using the refresh token
5. New tokens are saved for future use
6. Both access and refresh tokens are updated after each refresh


### Display Setup

For dedicated conference room displays:

1. **Set up a display device** (tablet, TV with computer, etc.) outside each conference room
2. **Open the web app** in full-screen mode (press F11 in most browsers)
3. **Use room-specific URLs** for each display:
   - Large Room Display: `http://your-server:8080?room=Large`
   - Small Room Display: `http://your-server:8080?room=Small`

## How It Works

1. **Data Fetching**: The server fetches today's appointments from Daylite API every time the frontend requests data
2. **Contact Resolution**: For each appointment, it fetches contact details to get first names
3. **Time Filtering**: Only shows appointments that:
   - Start within the next 30 minutes, OR
   - Are currently in progress
4. **Room Detection**: Identifies conference rooms based on resource IDs in Daylite
5. **Auto-Refresh**: Frontend polls the server every 30 seconds for updates

## API Endpoints

- `GET /api/appointments` - Returns filtered appointments with welcome information
- `GET /` - Serves the main display page

## Customization

### Styling
Edit `public/index.html` to modify:
- Colors and gradients
- Font sizes
- Animation effects
- Layout spacing

### Timing
In `server.js`, modify the `filterRelevantAppointments` function:
- Change the 30-minute preview window
- Adjust time zone handling
- Modify date formatting

### Room Configuration
In `server.js`, update the room detection logic:
```javascript
// Current room detection (line ~89)
if (appt.resources.join() == '/v1/resources/2015') {
  room = 'Large';
} else {
  room = 'Small';
}
```

## Deployment Options

### Local Network
1. Run on a dedicated machine in your office
2. Access from display devices using local IP address
