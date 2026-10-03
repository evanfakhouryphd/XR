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

## Deploying to Vercel (recommended)

1. In Vercel, click **Add New → Project** and import this GitHub repository.
2. Set **Root Directory** to `attendance`. Leave the framework preset as **Other** and the build settings empty. `vercel.json` handles the rest.
3. Click **Deploy**. The first deploy shows "No database configured" until the next step is done.
4. Open the project's **Storage** tab, then **Create Database** → **Neon** (serverless Postgres, free tier) → connect it to the project. This adds `DATABASE_URL` automatically.
5. Under **Deployments**, choose **Redeploy**. Open your `https://<project>.vercel.app` address and create your instructor account. The tables are created automatically on first use.

Vercel provides HTTPS, which the phone location check needs.

## Running it locally

You need Node.js 22. Locally the app uses an embedded Postgres (PGlite) stored in `./data`, so there is nothing else to install.

```bash
cd attendance
npm install
npm start          # http://localhost:3000
```

Students' phones can't reach `localhost`. To try it with real phones, run `npx cloudflared tunnel --url http://localhost:3000` and open the `https://…trycloudflare.com` address it prints.

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | unset, which uses PGlite in `./data` | Postgres connection string (Neon, Supabase, RDS, …) |
| `PUBLIC_URL` | address the browser used | Address put into the QR codes, e.g. a custom domain |
| `ALLOW_SIGNUP` | off | Set to `1` to let more instructors create accounts (the first account can always be created) |
| `QR_ROTATE_SECONDS` | `10` | How often the QR code changes |
| `QR_GRACE_WINDOWS` | `2` | How many earlier codes are still accepted (allows for slow scans) |
| `CHECKIN_WINDOW_MINUTES` | `5` | Time a first-time student has to fill in the registration form after scanning |
| `GEO_MAX_ACCURACY_M` | `75` | Location check: readings less precise than this are rejected (the student is asked to turn on Precise Location) |
| `GEO_SLACK_M` | `30` | Location check: the most GPS uncertainty forgiven on top of the class radius |
| `PORT`, `DATA_DIR`, `TRUST_PROXY` | | Settings for running on your own server |

Each class has its own **time zone** (Settings tab). It is taken from your browser when you create the class and is used for "today" and for marking students late.

## How to use it in class

1. **Classes → New class**, then **Schedule**: tick Mon/Wed/Fri, set the first and last day and the times, and click **Generate sessions**.
2. Optional: under **Students**, paste your roster (`student ID, name` per line). Under **Settings**, turn on roster-only and/or the location check. Set the location from the classroom, ideally on your phone.
3. At the start of class, open today's session, click **Start attendance & show QR**, and press **Full screen**.
4. Students scan the code. The count on screen goes up live.
5. Click **Close attendance**, then fix individual statuses if needed (for example, mark someone excused).
6. After the first week or two, turn off **Allow new phones to register** under **Settings**.

## Branding

The interface follows the LAU visual identity guidelines (Stratcom):
- **Colors:** Dark Green `#006751` is the dominant color and Anthracite `#3A3E3F` is the text color. The secondary greens and tertiary colors are used only for states and highlights.
- **Fonts:** Raleway for headings and PT Sans, the guide's web typeface, for body text. Both are self-hosted from `public/fonts` under the SIL Open Font License.
- **Logo:** the official logo is extracted unaltered from the style guide: `public/brand/lau-logo-white.svg` on Dark Green and `public/brand/lau-logo-green.svg` on white. It sits top-left, with clear space of at least the height of the "L", and is never shown below the minimum size.

## Development

```bash
npm test   # end-to-end tests of the check-in flow and the anti-cheating rules
```

Code layout: `server.js` (API and check-in logic), `lib/security.js` (rotating QR tokens, claims, passwords, distance), `lib/db.js` (Postgres schema and drivers), `lib/time.js` (time zones), `api/index.js` (Vercel entry), `public/` (instructor dashboard in `app.js`, student page in `checkin.js`).
