# Studyo — source code

A study companion for students with its own login, separate from a
staff/principal login and a family login. Staff register students,
link families, post calendar events, and upload class materials
(video, audio, worksheets, docs). Everyone only ever sees what applies
to them — enforced on the server, not just hidden in the interface.

```
studyo/
  backend/     Node.js API — auth, todos, streaks, leaderboard, messaging,
               file uploads, calendar, admin
  frontend/    Single HTML page — login screen + student/family/staff dashboards
```

## How the login system works

There are three separate login flows, all landing on the same page:

- **Student login** — a student signs in with their **student ID + full
  name**. There's no student self-registration: a staff member or the
  principal has to register the student first (from the Admin tab once
  logged in as staff). This is intentional — it keeps random people from
  creating student accounts, and it's how the student's name/class badge
  in the messaging system gets its data in the first place.
- **Family login** — a parent/guardian signs in with a **family ID +
  password**. Families can't self-register either: staff link a family
  to a specific student (Admin → Link a family account). A family can
  only ever message about — and only ever see — the student(s) they're
  linked to; the same family ID can be linked to more than one student
  for siblings.
- **Staff / principal login** — staff sign in with a **staff ID +
  password**, since they can register students, link families, upload
  materials, and reply to messages, so they need a real credential, not
  just a name.

Once logged in, the interface is different for each:
- **Students** see their to-do list, weekly streak, leaderboard, the
  AI study-buddy chat, study materials for their class, and upcoming
  events.
- **Families** see a simple messaging screen — pick a linked child, see
  the thread, send a message — plus upcoming events for their kid(s).
  Staff see the message tagged with that child's name + class
  automatically.
- **Staff/principal** see four tabs: Messages (family inbox tagged by
  student), Materials (upload/browse class files), Calendar (view
  events; only the principal can post/remove them), and Admin (stats,
  student table, register-student form, link-family form, and —
  principal only — a register-staff form plus remove buttons on the
  student and staff tables).

Messages, materials, and the calendar all **poll the server every
5–8 seconds** while their screen is open, so new items show up without
a manual refresh — that's the "communication actually works" part.

## Study materials (teacher uploads)

Staff → Materials → fill in a title, the class it's for, pick a type
(video/audio/worksheet/document/other), choose a real file, and upload.
It's saved to `backend/uploads/` on disk, and a record is added to the
database pointing at it. Students in that class (and families linked to
a student in that class) see it appear in their "Study materials" panel
and can open or download it directly — video/audio files play right in
the browser since they're served with the correct content type.

## Digital library (grade-level textbooks & teacher guides)

Staff → Library → upload a **PDF only** — title, subject, a resource
type (student textbook or teacher guide), and a grade level (1–12).
The backend rejects anything that isn't actually a PDF. Once uploaded,
it's immediately visible to every student in that grade automatically
— no extra step. Students see a "Digital library" section on their
dashboard with a search bar and a subject filter; each book has a
**View** button (opens the PDF in the browser's built-in reader in a
new tab) and a **Download** button (forces a save-as). Family accounts
don't see the library — it's student- and staff-facing only, per how
it was scoped.

## Student directory (staff)

The Admin tab's student table is a full directory: a search box (name
or student ID), sort A→Z or Z→A, and filter dropdowns for grade,
section, and gender — all client-side against the data already
loaded, so it's instant. Grade and section are both read automatically
from each student's `class` field (`"10A"` → grade 10, section A), so
there's nothing extra to fill in when registering a student — assign
a class like normal and the directory figures out the rest. Profile
pictures show as a small avatar in the first column when a student
has one uploaded.

## The calendar

Staff → Calendar shows every event that applies to the person viewing
it. Only the **principal** can post or remove events (enforced on the
backend, not just hidden in the UI) — pick an audience of `all` for a
whole-school event, or a class name (e.g. `9B`) to target one class.
Students, families, and other staff all see it show up automatically.

## Running it

You need [Node.js](https://nodejs.org) installed (v18+). Nothing else —
the backend has **zero external dependencies**, so there's no `npm
install` step.

**1. Start the backend**
```bash
cd backend
node server.js
```
You should see:
```
Studyo backend running at http://localhost:4001
```
It creates a `data.json` file and an `uploads/` folder next to
`server.js` the first time it runs — that's your database and your
file storage. Delete `data.json` any time to reset to the demo data
(this won't delete uploaded files themselves, just forgets they
existed — delete the `uploads/` folder too for a full reset).

**2. Open the frontend**

Just open `frontend/index.html` directly in a browser, or serve it
(recommended, avoids some browsers' quirks with `file://` pages):
```bash
cd frontend
python3 -m http.server 5500
```
then visit `http://localhost:5500`.

The frontend talks to the backend at `http://localhost:4001` by
default — see `API_BASE` near the top of the `<script>` in
`index.html` if you deploy the backend somewhere else.

## Demo accounts

| Role      | ID     | Password / name         |
|-----------|--------|--------------------------|
| Principal | P-1001 | admin123                 |
| Teacher   | T-2001 | teach123                 |
| Student   | S-3001 | Selam Tesfaye (as name)  |
| Family    | F-5001 | family123                |

Log in as staff first and use **Admin → Register a new student** to add
more students, and **Admin → Link a family account** to give a
parent/guardian their own login tied to that student. Then log out and
log back in as the student or family to see their side. Run the "link
a family" form again with the same family ID and a different student
ID to add a sibling to the same family account. Log in as **Materials**
or **Calendar** while logged in as staff to try uploading a file or
posting an event.

Log in as the **principal** specifically (P-1001 / admin123) to see
three extra things on the Admin tab: a "Register a new teacher / staff
member" form, a remove button on every row of the student table, and a
remove button on every row of the staff table (except your own account
— you can't remove yourself while logged in as it, and the last
remaining principal account can't be removed by anyone). Removing a
student also deletes their to-dos, streak history, and messages, and
unlinks them from any family — there's a confirmation prompt before
anything is deleted, since it can't be undone.

## What's real vs. what's a stand-in

This is a working system, good enough to actually run a small school's
data on — but a few things are deliberately simplified for "runs
immediately, zero setup," and are called out with comments right in
`backend/server.js`:

- **Storage** is a local `data.json` file plus an `uploads/` folder on
  disk — not a database *server*. Writes are atomic (crash-safe: it
  writes to a temp file and swaps it in, so a power cut mid-save can't
  corrupt your data), and this is genuinely durable for one school on
  one machine. What it can't do is be safely edited by two different
  *server processes* at once — for that you'd want a real database
  server (Postgres/MySQL) instead of a file. That's also the point
  where you'd need actual **hosting**: a real database runs on a
  server somewhere, not on a single laptop, so scaling past "runs on
  my computer" means renting a small server (e.g. a $5–10/month VPS,
  or a platform like Render/Railway/Fly.io) and pointing this backend
  at a hosted Postgres database instead of `data.json`. That's a real
  step up in complexity — happy to help with it when you're ready.
- **File links use a token in the URL** (`?token=...`) so `<a>`/`<video>`
  tags can authenticate without JavaScript attaching a header. That's
  simple and it works, but a token in a URL can end up in browser
  history or server logs. A hardened version would issue short-lived,
  single-purpose download links instead of reusing the login session
  token.
- **Session tokens** are a small hand-rolled signed-token scheme (HMAC
  over JSON, built from Node's `crypto` module) rather than a vetted
  JWT library — good enough to prove the auth flow works, but you'd
  want a maintained library plus refresh tokens for production.
- **"Live" updates are polling**, not a real-time push connection
  (WebSockets). Every 5–8 seconds the open screen quietly re-asks the
  server "anything new?" — simple, reliable, and needs no extra
  infrastructure, but it's not instant and it's a bit more network
  traffic than a push-based system. Fine at small school scale.
- **The AI assistant** replies using simple rule-based logic out of the
  box (no external calls, so it works immediately). If you set an
  `ANTHROPIC_API_KEY` environment variable before starting the server,
  it will automatically use the real Claude API instead — see
  `callClaude()` in `server.js`.
- No HTTPS, rate limiting, virus scanning on uploads, or input
  validation beyond the basics — add these before putting this
  somewhere real students, families, or their files will be exposed
  to the open internet.

