#!/usr/bin/env node

/**
 * Test script to verify Daylite API token refresh
 */

require('dotenv').config();

async function testTokenRefresh() {
  console.log('🔍 Testing Daylite Token Refresh\n');
  
  const refreshToken = process.env.DAYLITE_REFRESH_TOKEN;
  
  if (!refreshToken) {
    console.error('❌ No refresh token found in environment variables');
    console.log('Please set DAYLITE_REFRESH_TOKEN in your .env file');
    process.exit(1);
  }
  
  console.log('📡 Attempting to refresh token...');
  console.log('Refresh token:', refreshToken.substring(0, 10) + '...\n');
  
  try {
    const url = `https://api.marketcircle.net/v1/personal_token/refresh_token?refresh_token=${encodeURIComponent(refreshToken)}`;
    console.log(url);

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
    console.log('\n✅ Token refreshed successfully!\n');
    console.log('Response structure:');
    console.log('- New access token:', data.access_token ? '✓ Present' : '✗ Missing');
    console.log('- New refresh token:', data.refresh_token ? '✓ Present' : '✗ Missing');
    console.log('- Token type:', data.token_type || 'Not specified');
    console.log('- Expires in:', data.expires_in ? `${data.expires_in} seconds` : 'Not specified');
    
    if (data.access_token) {
      console.log('\n🔐 Testing new access token...');
      const testUrl = 'https://api.marketcircle.net/v1/appointments?limit=1';
      const testResponse = await fetch(testUrl, {
        headers: {
          'Authorization': `Bearer ${data.access_token}`,
          'Accept': 'application/json'
        }
      });
      
      if (testResponse.ok) {
        console.log('✅ New access token is valid!');
      } else {
        console.log('⚠️  New access token test failed with status:', testResponse.status);
      }
    }
    
    console.log('\n💡 To use these tokens, update your .env file:');
    console.log(`DAYLITE_ACCESS_TOKEN=${data.access_token || data.token}`);
    console.log(`DAYLITE_REFRESH_TOKEN=${data.refresh_token || refreshToken}`);
    
  } catch (error) {
    console.error('❌ Error during token refresh:', error.message);
    process.exit(1);
  }
}

testTokenRefresh();
