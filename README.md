# DUEL UP — Real-time multiplayer package

This is a deployable Node.js + Express + Socket.IO website. It supports real-time room creation/joining and quick matchmaking between browsers connected to the same deployed server.

## Run locally
1. Install Node.js 18 or newer from https://nodejs.org/
2. Open a terminal in this folder.
3. Run `npm install`
4. Run `npm start`
5. Open http://localhost:3000 in your browser.
6. To test multiplayer locally, open a second browser/incognito window at the same address.

## Deploy online (Render)
1. Create a GitHub account at https://github.com and a Render account at https://render.com if you don't already have them.
2. Create a new GitHub repository and upload these project files, keeping `server.js`, `package.json`, and the `public` folder at the repository root.
3. In Render, choose **New → Web Service** and connect your repository.
4. Set **Build Command** to `npm install`.
5. Set **Start Command** to `npm start`.
6. Choose a free/available instance if offered, then deploy. Render supplies the `PORT` environment variable automatically.
7. Open the `onrender.com` URL Render provides. Share that URL with friends.

## Game details and limits
- Tic-Tac-Toe and Connect Four: server-validated real-time two-player games.
- Battleship: randomized hidden fleets remain on the server; shots are synchronized. The win condition is 12 ship sections.
- Cup Pong: synchronized turn-based cup game. The browser provides an aim/throw attempt and the server determines whether a shot lands.
- 8-Ball Pool: synchronized turn-based arcade pool with simplified shot outcomes, not full physical simulation.
- Room codes are temporary in-memory rooms. If the server restarts, rooms and matches are lost.
- No accounts or persistent cross-device profiles yet.
- This is an initial prototype. Add rate limits, stricter matchmaking lifecycle handling, automated tests, and production monitoring before treating it as a large public service.

## Security notes
The server validates turn order and legal board moves for Tic-Tac-Toe, Connect Four, and Battleship. This starter is intended for a small friend group/testing, not high-traffic production. Use HTTPS through the host's managed TLS.
