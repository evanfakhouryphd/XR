# QR Class Attendance

A small web app for taking attendance at university classes with QR codes.

- **Classes and schedules:** create a class, pick its meeting days (e.g. Mon/Wed/Fri) and a date range, and the app creates one session per meeting. You can also add or delete single sessions.
- **One QR code per session:** start a session and put the QR code on the projector. Students scan it with their phone camera to check in.
- **No typing after the first scan:** the first scan links the phone to the student's ID (a one-time form). After that, scanning checks them in right away.
- **Reports:** a per-session list where you can change any student's status (present, late, excused or absent), a students × sessions grid with attendance rates, and a CSV download.

## Anti-cheating

| Trick | What stops it |
|---|---|
| Sending a photo or screenshot of the QR to a friend who isn't in class | The QR code changes every **10 seconds** and a code only works for about 30 seconds. A forwarded code has expired by the time the friend opens it. Each attempt is recorded under **Alerts**. |
| Checking in a friend from my own phone | Each phone is linked to **one** student ID and checks in only that student. Registering a second ID on the same phone is refused. |
| Registering a friend's ID on another phone | Each student ID is linked to **one** phone. A second phone is refused and the attempt shows up under **Alerts**. If a student really did change phones, you click **Reset phone**. |
| A private or incognito tab, used to look like a new phone | You turn off **Allow new phones to register** once everyone has signed up (after a week or two). From then on, only phones that are already linked can check in. The session page also warns you when two check-ins came from an identical browser on the same network within minutes of each other. |
| Scanning a code someone streams live from inside the room | Optional **location check**: you set the classroom location and a radius, and phones outside it are rejected. |
| Made-up or mistyped IDs | Optional **roster-only** mode: paste your class list and only IDs on it are accepted. |

**What it can't do.** A web page cannot read a phone's identity (phone number, IMEI, Apple or Google account) without the student typing something once. That's why there's a one-time registration. After that, the phone is recognized by a secure cookie. No web-based system is cheat-proof: a student who hands their actual phone to a friend in the room can still check in that way. Comparing the count with a quick headcount covers that case.

## Running it

You need **Node.js 22.13 or newer**. It uses Node's built-in SQLite, so there is no database to install.

```bash
cd attendance
npm install
npm start          # http://localhost:3000
```

Open the address in your browser and create your instructor account. The first account is created freely; to allow more, set `ALLOW_SIGNUP=1`.

### Students' phones must be able to reach the server, over HTTPS

`localhost` works only on your own computer. For real use, put the app on a public HTTPS address. HTTPS is also required for the location check. Some options:

- **Quick test from your laptop:** run `npx cloudflared tunnel --url http://localhost:3000` (or use ngrok), then start the app with `PUBLIC_URL=https://<the-tunnel-address> npm start`.
- **Permanent hosting:** any Node host with a persistent disk works (Render, Railway, Fly.io, a university VM, and so on). Set `PUBLIC_URL` and `TRUST_PROXY=1`, and keep `DB_FILE` on the persistent disk.

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `PUBLIC_URL` | address the browser used | Address put into the QR codes, e.g. `https://attendance.myuni.edu` |
| `DB_FILE` | `./data/attendance.db` | SQLite database file |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy or load balancer |
| `ALLOW_SIGNUP` | off | Set to `1` to let more instructors create accounts |
| `QR_ROTATE_SECONDS` | `10` | How often the QR code changes |
| `QR_GRACE_WINDOWS` | `2` | How many earlier codes are still accepted (allows for slow scans) |
| `CHECKIN_WINDOW_MINUTES` | `5` | Time a first-time student has to fill in the registration form after scanning |
| `TZ` | system | Time zone used for session times and "late" marking, e.g. `Asia/Beirut` |

## How to use it in class

1. **Classes → New class**, then **Schedule**: tick Mon/Wed/Fri, set the first and last day and the times, and click **Generate sessions**.
2. Optional: under **Students**, paste your roster (`student ID, name` per line). Under **Settings**, turn on roster-only and/or the location check. Set the location from the classroom, ideally on your phone.
3. At the start of class, open today's session, click **Start attendance & show QR**, and press **Full screen**.
4. Students scan the code. The count on screen goes up live.
5. Click **Close attendance**, then fix individual statuses if needed (for example, mark someone excused).
6. After the first week or two, turn off **Allow new phones to register** under **Settings**.

## Development

```bash
npm test   # end-to-end tests of the check-in flow and the anti-cheating rules
```

Code layout: `server.js` (API and check-in logic), `lib/security.js` (rotating QR tokens, claims, passwords, distance), `lib/db.js` (database schema), `public/` (instructor dashboard in `app.js`, student page in `checkin.js`).
