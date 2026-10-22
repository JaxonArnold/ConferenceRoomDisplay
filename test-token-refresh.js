#!/usr/bin/env node

/**
 * Test script to verify Daylite API token refresh
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const TOKEN_FILE = path.join(__dirname, 'tokens.json');

// The server keeps the current refresh token in tokens.json; the one in .env
// is only the initial token and goes stale after the first refresh.
function loadSavedTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (error) {
    return null;
  }
}

async function testTokenRefresh() {
  console.log('🔍 Testing Daylite Token Refresh\n');

  const saved = loadSavedTokens();
  const refreshToken = (saved && saved.refreshToken) || process.env.DAYLITE_REFRESH_TOKEN;

  if (!refreshToken) {
    console.error('❌ No refresh token found in tokens.json or environment variables');
    console.log('Please set DAYLITE_REFRESH_TOKEN in your .env file');
    process.exit(1);
  }

  console.log(`📡 Attempting to refresh token from ${saved && saved.refreshToken ? 'tokens.json' : '.env'}...\n`);

  try {
    const url = `https://api.marketcircle.net/v1/personal_token/refresh_token?refresh_token=${encodeURIComponent(refreshToken)}`;

    // The Daylite token refresh endpoint expects a GET request with the
    // refresh token in the querystring. Use GET (or no method) instead of POST.
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });

    console.log('Response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Failed to refresh token');
      console.error('Error:', errorText);
      process.exit(1);
    }

    const data = await response.json();
    const accessToken = data.access_token || data.token;
    console.log('\n✅ Token refreshed successfully!\n');
    console.log('Response structure:');
    console.log('- New access token:', accessToken ? '✓ Present' : '✗ Missing');
    console.log('- New refresh token:', data.refresh_token ? '✓ Present' : '✗ Missing');
    console.log('- Token type:', data.token_type || 'Not specified');
    console.log('- Expires in:', data.expires_in ? `${data.expires_in} seconds` : 'Not specified');

    if (!accessToken) {
      process.exit(1);
    }

    // Save the new tokens where the server reads them, so the refresh token
    // that was just exchanged isn't left behind in tokens.json
    const tokens = {
      accessToken,
      refreshToken: data.refresh_token || refreshToken,
      tokenExpiry: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString()
    };
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    fs.chmodSync(TOKEN_FILE, 0o600);
    console.log('\n💾 Saved new tokens to tokens.json');
    console.log('   If the server is running, restart it so it picks them up.');

    console.log('\n🔐 Testing new access token...');
    const testUrl = 'https://api.marketcircle.net/v1/appointments?limit=1';
    const testResponse = await fetch(testUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    });

    if (testResponse.ok) {
      console.log('✅ New access token is valid!');
    } else {
      console.log('⚠️  New access token test failed with status:', testResponse.status);
    }

  } catch (error) {
    console.error('❌ Error during token refresh:', error.message);
    process.exit(1);
  }
}

testTokenRefresh();
