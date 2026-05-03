# Orbit Duel

Two-phone precision reaction game. One player creates a room, the second joins with a code, and both tap when the orbiting dot reaches the glowing target zone.

## Local Run

```powershell
cd orbit-duel
node server.js
```

Open `http://localhost:3001` on this computer, or use the `Phone URL` printed by the server on two phones connected to the same Wi-Fi.

## Checks

```powershell
npm.cmd run check
```

PowerShell may block `npm`, so use `npm.cmd` on Windows if needed.

## Render Deployment

Deploy the contents of this `orbit-duel` folder as the root of a GitHub repo.

Render settings:

- Service type: Web Service
- Environment/runtime: Node
- Root Directory: leave empty if this folder is the repo root
- Build Command: `npm install`
- Start Command: `node server.js`

The server listens on `process.env.PORT` when Render provides it, and falls back to `3001` locally.

## Manual Steps

1. Create a GitHub repo, for example `orbit-duel`.
2. Upload or push the contents of this folder as the repo root.
3. Log in to Render.
4. Choose **New -> Web Service**.
5. Connect the GitHub repo.
6. Use the Render settings above.
7. Wait for deploy to finish.
8. Open the public `onrender.com` URL on both phones.

## Gameplay

- One player creates a room.
- The second player joins with the room code.
- The host chooses difficulty and starts a 20-round match.
- Tap when the orbiting dot is closest to the glowing target zone.
- Closer taps score more points. False starts lose 25 points.
- Finished matches are saved in `data/matches.json`.

## Online History Note

The current online version uses temporary JSON file history. Gameplay works normally, but history may reset when the cloud service restarts or redeploys. Add a database or persistent disk later if permanent online match history is required.
