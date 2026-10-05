import 'dotenv/config';
import http from 'node:http';
import { google } from 'googleapis';
import { URL } from 'node:url';

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const redirectUri = process.env.GOOGLE_LOCAL_REDIRECT_URI || 'http://localhost:3000/oauth2callback';

if (!clientId || !clientSecret) {
  console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env');
  process.exit(1);
}

const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
const authUrl = auth.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/drive.file']
});

console.log('\nOpen this URL in your browser:\n');
console.log(authUrl);
console.log('\nWaiting for OAuth callback on http://localhost:3000/oauth2callback ...\n');

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, 'http://localhost:3000');
    if (requestUrl.pathname !== '/oauth2callback') {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    const code = requestUrl.searchParams.get('code');
    const error = requestUrl.searchParams.get('error');
    if (error) throw new Error(`Google OAuth error: ${error}`);
    if (!code) throw new Error('Missing OAuth code.');

    const { tokens } = await auth.getToken(code);
    console.log('\n================ REFRESH TOKEN ================\n');
    console.log(tokens.refresh_token || '(Google did not return a refresh token. Re-run with prompt=consent.)');
    console.log('\n=================================================\n');
    console.log('Put that value into .env as GOOGLE_REFRESH_TOKEN.\n');

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Google autorizacija je uspjela.</h1><p>Vrati se u terminal i kopiraj refresh token u <code>.env</code>.</p>');
    setTimeout(() => server.close(), 500);
  } catch (error) {
    console.error(error);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String(error.message || error));
    setTimeout(() => server.close(), 500);
  }
});

server.listen(3000, '127.0.0.1');
