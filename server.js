/**
 * Studyo backend
 * -----------------------------------------------------------------------
 * Zero-dependency Node.js server. Run with: node server.js
 * No `npm install` needed — everything here uses Node's built-in modules
 * (http, crypto, fs, path) on purpose, so the project runs immediately.
 *
 * WHAT THIS DEMONSTRATES
 *  - Three separate login flows, all issuing the same kind of session token:
 *      1) Student login  -> student ID + full name (matched against a
 *         record a staff member created ahead of time)
 *      2) Staff / principal login -> staff ID + password
 *      3) Family login -> family ID + password, linked to one or more
 *         students by staff (a family can only ever see/message about
 *         the student(s) they're linked to)
 *  - Staff/principal accounts are the only ones that can *register* a
 *    new student or link a new family into the system.
 *  - A student (or family) can only ever see/edit their own data
 *    (enforced by the token, not by anything the client sends).
 *  - Teachers/staff can upload real files (video, audio, docs, worksheets)
 *    as "materials", scoped to a class — students only see materials for
 *    their own class, families only see materials for their linked kids.
 *  - The principal can post calendar events (whole-school or one class);
 *    everyone logged in can see the events that apply to them.
 *  - Messaging, materials, and the calendar all poll the server every few
 *    seconds while their screen is open, so new messages/files/events
 *    show up without a manual refresh.
 *
 * STORAGE: a local JSON file (data.json) written atomically (write to a
 * temp file, then rename over the real one) so a crash mid-write can't
 * corrupt your data. This is genuinely durable for a single school's
 * worth of data on one machine — but it is still one file, not a real
 * multi-user database server. If you outgrow it (many staff editing at
 * once, need remote access from multiple servers, etc.), the natural
 * next step is Postgres/MySQL behind a proper host — see README.md for
 * what that involves. Everywhere else a shortcut is taken for the same
 * "runs immediately with zero setup" reason, there's a comment marking it:
 *  - a vetted JWT library + refresh-token flow instead of the hand-rolled
 *    signed token below
 *  - HTTPS, rate limiting, and stricter input validation
 *  - a real password reset flow for staff and families
 *  - antivirus scanning / stricter file-type checks on uploads
 * -----------------------------------------------------------------------
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4000;
const DB_FILE = path.join(__dirname, 'data.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Max upload size, in bytes (25 MB). Adjust to taste.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// DEMO ONLY: in production this must come from a secret manager / env var
// that is never committed to source control.
const TOKEN_SECRET = process.env.STUDYO_SECRET || 'studyo-dev-secret-change-me';

/* ------------------------------------------------------------------ */
/* tiny JSON-file "database"                                          */
/* ------------------------------------------------------------------ */

function seedData() {
  const now = new Date().toISOString();
  return {
    staff: [
      {
        id: 'st_1',
        staffId: 'P-1001',
        name: 'Principal Almaz Bekele',
        role: 'principal',
        passwordHash: hashPassword('admin123'),
        createdAt: now,
      },
      {
        id: 'st_2',
        staffId: 'T-2001',
        name: 'Mrs. Kebede',
        role: 'teacher',
        passwordHash: hashPassword('teach123'),
        createdAt: now,
      },
    ],
    students: [
      { id: 'stu_1', studentId: 'S-3001', name: 'Selam Tesfaye', class: '9B', points: 388, registeredBy: 'P-1001', createdAt: now },
      { id: 'stu_2', studentId: 'S-3002', name: 'Nardos Haile', class: '9B', points: 412, registeredBy: 'P-1001', createdAt: now },
      { id: 'stu_3', studentId: 'S-3003', name: 'Dawit Alemu', class: '7A', points: 301, registeredBy: 'T-2001', createdAt: now },
    ],
    families: [
      {
        id: 'fam_1',
        familyId: 'F-5001',
        name: 'Tesfaye Family',
        studentIds: ['S-3001'],
        passwordHash: hashPassword('family123'),
        linkedBy: 'P-1001',
        createdAt: now,
      },
    ],
    todos: [
      { id: 'td_1', studentId: 'S-3001', text: 'Review chapter 4 — algebra', tag: 'math', done: true, createdAt: now },
      { id: 'td_2', studentId: 'S-3001', text: 'Finish biology worksheet', tag: 'sci', done: false, createdAt: now },
    ],
    // streaks[studentId] = array of "YYYY-MM-DD" strings the student completed at least one task
    streaks: {
      'S-3001': lastNDates(6),
    },
    messages: [
      {
        id: 'msg_1',
        studentId: 'S-3001',
        from: 'Mrs. Tesfaye (parent)',
        to: 'Homeroom teacher',
        body: 'Good afternoon, Selam mentioned a math test next week — could you confirm the date?',
        direction: 'in',
        time: now,
      },
    ],
    materials: [],
    calendarEvents: [
      {
        id: 'ev_1',
        title: 'First term math exam',
        date: addDays(7),
        time: '09:00',
        description: 'Algebra and geometry, chapters 1–4.',
        audience: '9B',
        createdBy: 'P-1001',
        createdByName: 'Principal Almaz Bekele',
        createdAt: now,
      },
    ],
  };
}

function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function lastNDates(n) {
  const out = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(d);
    dt.setDate(d.getDate() - i);
    out.push(dt.toISOString().slice(0, 10));
  }
  return out;
}

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const seeded = seedData();
    saveDB(seeded);
    return seeded;
  }
  const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  // Migration guard: fill in any tables added after this file was first created,
  // so upgrading the server code never crashes on an older data.json.
  if (!loaded.materials) loaded.materials = [];
  if (!loaded.library) loaded.library = [];
  if (!loaded.calendarEvents) loaded.calendarEvents = [];
  if (!loaded.families) loaded.families = [];
  return loaded;
}

function saveDB(dbToSave) {
  // Atomic write: write to a temp file first, then rename over the real
  // file. If the process crashes mid-write, data.json itself is never
  // left half-written — the rename either fully happens or doesn't.
  const tmpFile = DB_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(dbToSave, null, 2));
  fs.renameSync(tmpFile, DB_FILE);
}

let db = loadDB();

/* ------------------------------------------------------------------ */
/* password hashing (scrypt, built into Node — no bcrypt dependency)  */
/* ------------------------------------------------------------------ */

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* signed session tokens (a minimal hand-rolled stand-in for JWT)     */
/* ------------------------------------------------------------------ */

function signToken(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (Date.now() - payload.iat > SEVEN_DAYS) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* request helpers                                                    */
/* ------------------------------------------------------------------ */

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (maxBytes && total > maxBytes) {
        req.destroy();
        reject(new Error('File is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Minimal multipart/form-data parser — no dependency needed for the one
 * thing this app uses file uploads for. Handles the standard shape a
 * browser's FormData + fetch() produces: text fields plus a single file
 * field. Good enough for this app; a hardened version would use a
 * streaming parser instead of buffering the whole request in memory.
 */
function parseMultipart(buffer, boundary) {
  const boundaryBuf = Buffer.from('--' + boundary);
  const result = { fields: {}, files: {} };
  let start = buffer.indexOf(boundaryBuf);
  while (start !== -1) {
    const next = buffer.indexOf(boundaryBuf, start + boundaryBuf.length);
    if (next === -1) break;
    let part = buffer.slice(start + boundaryBuf.length, next);
    if (part.slice(0, 2).toString('latin1') === '\r\n') part = part.slice(2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerStr = part.slice(0, headerEnd).toString('utf8');
      let body = part.slice(headerEnd + 4);
      if (body.slice(-2).toString('latin1') === '\r\n') body = body.slice(0, -2);
      const nameMatch = headerStr.match(/name="([^"]*)"/i);
      const filenameMatch = headerStr.match(/filename="([^"]*)"/i);
      const ctMatch = headerStr.match(/content-type:\s*(.+)/i);
      if (nameMatch) {
        if (filenameMatch && filenameMatch[1]) {
          result.files[nameMatch[1]] = {
            filename: filenameMatch[1],
            contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
            data: body,
          };
        } else {
          result.fields[nameMatch[1]] = body.toString('utf8');
        }
      }
    }
    start = next;
  }
  return result;
}

function getAuth(req) {
  const header = req.headers['authorization'] || '';
  let token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    // Allows direct links (e.g. <a href>, <video src>) to authenticate
    // without JS attaching a header — used only for file downloads/views.
    // DEMO SHORTCUT: a token in the URL can end up in browser history or
    // server access logs. A hardened version would issue short-lived,
    // single-purpose download tokens instead of reusing the session token.
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      token = url.searchParams.get('token');
    } catch {
      token = null;
    }
  }
  const payload = verifyToken(token);
  return payload; // { type: 'student'|'staff'|'family', id, ... } or null
}

function requireStudent(req, res) {
  const auth = getAuth(req);
  if (!auth || auth.type !== 'student') {
    send(res, 401, { error: 'Log in as a student to do this.' });
    return null;
  }
  return auth;
}

function requireStaff(req, res) {
  const auth = getAuth(req);
  if (!auth || auth.type !== 'staff') {
    send(res, 401, { error: 'Log in as staff to do this.' });
    return null;
  }
  return auth;
}

function requireFamily(req, res) {
  const auth = getAuth(req);
  if (!auth || auth.type !== 'family') {
    send(res, 401, { error: 'Log in as a family to do this.' });
    return null;
  }
  return auth;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* route handlers                                                     */
/* ------------------------------------------------------------------ */

async function handleStaffLogin(req, res) {
  const { staffId, password } = await readBody(req);
  if (!staffId || !password) return send(res, 400, { error: 'Enter a staff ID and password.' });
  const staff = db.staff.find((s) => s.staffId.toLowerCase() === String(staffId).toLowerCase());
  if (!staff || !verifyPassword(password, staff.passwordHash)) {
    return send(res, 401, { error: "That staff ID or password doesn't match our records." });
  }
  const token = signToken({ type: 'staff', id: staff.staffId, role: staff.role, name: staff.name });
  send(res, 200, { token, profile: { staffId: staff.staffId, name: staff.name, role: staff.role } });
}

async function handleStudentLogin(req, res) {
  const { studentId, name } = await readBody(req);
  if (!studentId || !name) return send(res, 400, { error: 'Enter your student ID and full name.' });
  const student = db.students.find(
    (s) => s.studentId.toLowerCase() === String(studentId).toLowerCase() &&
           s.name.trim().toLowerCase() === String(name).trim().toLowerCase()
  );
  if (!student) {
    return send(res, 401, { error: "That ID and name don't match a registered student. Ask your teacher or principal to register you first." });
  }
  const token = signToken({ type: 'student', id: student.studentId, name: student.name, class: student.class });
  send(res, 200, { token, profile: { studentId: student.studentId, name: student.name, class: student.class, points: student.points } });
}

async function handleFamilyLogin(req, res) {
  const { familyId, password } = await readBody(req);
  if (!familyId || !password) return send(res, 400, { error: 'Enter your family ID and password.' });
  const family = db.families.find((f) => f.familyId.toLowerCase() === String(familyId).toLowerCase());
  if (!family || !verifyPassword(password, family.passwordHash)) {
    return send(res, 401, { error: "That family ID or password doesn't match our records." });
  }
  const token = signToken({ type: 'family', id: family.familyId, name: family.name, studentIds: family.studentIds });
  const students = db.students.filter((s) => family.studentIds.includes(s.studentId))
    .map((s) => ({ studentId: s.studentId, name: s.name, class: s.class }));
  send(res, 200, { token, profile: { familyId: family.familyId, name: family.name, students } });
}

async function handleRegisterFamily(req, res) {
  const auth = requireStaff(req, res);
  if (!auth) return;
  const { familyId, name, password, studentId } = await readBody(req);
  if (!familyId || !name || !password || !studentId) {
    return send(res, 400, { error: 'Provide a family ID, name, password, and the student to link.' });
  }
  const student = db.students.find((s) => s.studentId.toLowerCase() === String(studentId).toLowerCase());
  if (!student) return send(res, 404, { error: 'No student with that ID — register the student first.' });

  let family = db.families.find((f) => f.familyId.toLowerCase() === String(familyId).toLowerCase());
  if (family) {
    // Existing family account — just link the additional student (e.g. a sibling).
    if (!family.studentIds.includes(student.studentId)) family.studentIds.push(student.studentId);
  } else {
    family = {
      id: 'fam_' + crypto.randomBytes(4).toString('hex'),
      familyId,
      name,
      studentIds: [student.studentId],
      passwordHash: hashPassword(password),
      linkedBy: auth.id,
      createdAt: new Date().toISOString(),
    };
    db.families.push(family);
  }
  saveDB(db);
  send(res, 201, { family: { familyId: family.familyId, name: family.name, studentIds: family.studentIds } });
}

function handleFamilyMessages(req, res) {
  const auth = requireFamily(req, res);
  if (!auth) return;
  const messages = db.messages
    .filter((m) => auth.studentIds.includes(m.studentId))
    .map((m) => {
      const student = db.students.find((s) => s.studentId === m.studentId);
      return { ...m, studentName: student ? student.name : m.studentId, studentClass: student ? student.class : '' };
    });
  send(res, 200, { messages });
}

async function handleFamilySendMessage(req, res) {
  const auth = requireFamily(req, res);
  if (!auth) return;
  const { studentId, body } = await readBody(req);
  if (!studentId || !body || !body.trim()) return send(res, 400, { error: 'Choose a child and write a message.' });
  if (!auth.studentIds.includes(studentId)) {
    return send(res, 403, { error: "You're not linked to that student." });
  }
  const msg = {
    id: 'msg_' + crypto.randomBytes(4).toString('hex'),
    studentId,
    from: auth.name,
    to: 'School staff',
    body: body.trim(),
    direction: 'in',
    time: new Date().toISOString(),
  };
  db.messages.push(msg);
  saveDB(db);
  send(res, 201, { message: msg });
}

async function handleRegisterStudent(req, res) {
  const auth = requireStaff(req, res);
  if (!auth) return;

  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(.+)$/);
  if (!boundaryMatch) return send(res, 400, { error: 'Expected a multipart form submission.' });

  let raw;
  try {
    raw = await readRawBody(req, MAX_UPLOAD_BYTES);
  } catch (e) {
    return send(res, 413, { error: e.message || 'File is too large.' });
  }
  const { fields, files } = parseMultipart(raw, boundaryMatch[1]);
  const studentId = (fields.studentId || '').trim();
  const name = (fields.name || '').trim();
  const cls = (fields.class || '').trim();
  const gender = (fields.gender || '').trim();
  const photo = files.photo;
  if (!studentId || !name || !cls || !gender) {
    return send(res, 400, { error: 'Provide a student ID, name, class, and gender.' });
  }
  if (photo && photo.data.length) {
    const allowedTypes = ['image/jpeg', 'image/png'];
    if (!allowedTypes.includes(photo.contentType.toLowerCase())) {
      return send(res, 400, { error: 'Profile pictures must be JPEG or PNG files.' });
    }
  }
  if (db.students.some((s) => s.studentId.toLowerCase() === String(studentId).toLowerCase())) {
    return send(res, 409, { error: 'A student with that ID already exists.' });
  }

  let photoUrl;
  if (photo && photo.data.length) {
    const extension = photo.contentType.toLowerCase() === 'image/png' ? '.png' : '.jpg';
    const storedName = 'student_' + crypto.randomBytes(10).toString('hex') + extension;
    fs.writeFileSync(path.join(UPLOADS_DIR, storedName), photo.data);
    photoUrl = `/api/student-photos/${storedName}`;
  }
  const student = {
    id: 'stu_' + crypto.randomBytes(4).toString('hex'),
    studentId,
    name,
    class: cls,
    gender,
    ...(photoUrl ? { photoUrl } : {}),
    points: 0,
    registeredBy: auth.id,
    createdAt: new Date().toISOString(),
  };
  db.students.push(student);
  db.streaks[studentId] = [];
  saveDB(db);
  send(res, 201, { student });
}

function handleListStudents(req, res) {
  const auth = requireStaff(req, res);
  if (!auth) return;
  send(res, 200, { students: db.students });
}

function handleDeleteStudent(req, res, studentId) {
  const auth = requireStaff(req, res);
  if (!auth) return;
  if (auth.role !== 'principal') return send(res, 403, { error: 'Only the principal can remove students.' });

  const student = db.students.find((s) => s.studentId === studentId);
  if (!student) return send(res, 404, { error: 'Student not found.' });

  db.students = db.students.filter((s) => s.studentId !== studentId);
  db.todos = db.todos.filter((todo) => todo.studentId !== studentId);
  db.messages = db.messages.filter((message) => message.studentId !== studentId);
  delete db.streaks[studentId];
  db.families.forEach((family) => {
    family.studentIds = family.studentIds.filter((id) => id !== studentId);
  });
  saveDB(db);

  if (student.photoUrl) {
    const storedName = path.basename(student.photoUrl);
    try { fs.unlinkSync(path.join(UPLOADS_DIR, storedName)); } catch {}
  }
  send(res, 200, { ok: true });
}

function handleListFamilies(req, res) {
  const auth = requireStaff(req, res);
  if (!auth) return;
  const families = db.families.map((f) => ({
    familyId: f.familyId,
    name: f.name,
    studentIds: f.studentIds,
    studentNames: f.studentIds.map((sid) => db.students.find((s) => s.studentId === sid)?.name || sid),
  }));
  send(res, 200, { families });
}

function handleListStaff(req, res) {
  const auth = requireStaff(req, res);
  if (!auth) return;
  const staff = db.staff.map(({ passwordHash, ...profile }) => profile);
  send(res, 200, { staff });
}

function handleMe(req, res) {
  const auth = getAuth(req);
  if (!auth) return send(res, 401, { error: 'Not logged in.' });
  if (auth.type === 'student') {
    const student = db.students.find((s) => s.studentId === auth.id);
    return send(res, 200, { type: 'student', profile: student });
  }
  if (auth.type === 'family') {
    const students = db.students.filter((s) => auth.studentIds.includes(s.studentId))
      .map((s) => ({ studentId: s.studentId, name: s.name, class: s.class }));
    return send(res, 200, { type: 'family', profile: { familyId: auth.id, name: auth.name, students } });
  }
  const staff = db.staff.find((s) => s.staffId === auth.id);
  send(res, 200, { type: 'staff', profile: { staffId: staff.staffId, name: staff.name, role: staff.role } });
}

function handleGetTodos(req, res) {
  const auth = requireStudent(req, res);
  if (!auth) return;
  const todos = db.todos.filter((t) => t.studentId === auth.id);
  send(res, 200, { todos });
}

async function handleAddTodo(req, res) {
  const auth = requireStudent(req, res);
  if (!auth) return;
  const { text, tag } = await readBody(req);
  if (!text || !text.trim()) return send(res, 400, { error: 'Write a task first.' });
  const todo = {
    id: 'td_' + crypto.randomBytes(4).toString('hex'),
    studentId: auth.id,
    text: text.trim(),
    tag: tag || 'math',
    done: false,
    createdAt: new Date().toISOString(),
  };
  db.todos.push(todo);
  saveDB(db);
  send(res, 201, { todo });
}

async function handleToggleTodo(req, res, id) {
  const auth = requireStudent(req, res);
  if (!auth) return;
  const todo = db.todos.find((t) => t.id === id && t.studentId === auth.id);
  if (!todo) return send(res, 404, { error: 'Task not found.' });
  todo.done = !todo.done;
  if (todo.done) {
    const streak = db.streaks[auth.id] || (db.streaks[auth.id] = []);
    const today = todayStr();
    if (!streak.includes(today)) {
      streak.push(today);
      const student = db.students.find((s) => s.studentId === auth.id);
      if (student) student.points += 10;
    }
  }
  saveDB(db);
  send(res, 200, { todo });
}

function handleDeleteTodo(req, res, id) {
  const auth = requireStudent(req, res);
  if (!auth) return;
  const before = db.todos.length;
  db.todos = db.todos.filter((t) => !(t.id === id && t.studentId === auth.id));
  if (db.todos.length === before) return send(res, 404, { error: 'Task not found.' });
  saveDB(db);
  send(res, 200, { ok: true });
}

function handleStreak(req, res) {
  const auth = requireStudent(req, res);
  if (!auth) return;
  const dates = db.streaks[auth.id] || [];
  const week = [];
  const d = new Date();
  const dayIdx = (d.getDay() + 6) % 7; // Monday = 0
  const monday = new Date(d);
  monday.setDate(d.getDate() - dayIdx);
  for (let i = 0; i < 7; i++) {
    const dt = new Date(monday);
    dt.setDate(monday.getDate() + i);
    const iso = dt.toISOString().slice(0, 10);
    week.push({ date: iso, done: dates.includes(iso) });
  }
  // current streak length counting back from today
  let count = 0;
  const cursor = new Date();
  while (dates.includes(cursor.toISOString().slice(0, 10))) {
    count++;
    cursor.setDate(cursor.getDate() - 1);
  }
  send(res, 200, { week, streakCount: count });
}

function handleLeaderboard(req, res) {
  const auth = getAuth(req);
  if (!auth) return send(res, 401, { error: 'Log in to see the leaderboard.' });
  const classFilter = auth.type === 'student' ? auth.class : null;
  const list = db.students
    .filter((s) => !classFilter || s.class === classFilter)
    .slice()
    .sort((a, b) => b.points - a.points)
    .map((s) => ({ name: s.name, class: s.class, points: s.points, studentId: s.studentId }));
  send(res, 200, { leaderboard: list });
}

function handleStaffMessages(req, res) {
  const auth = requireStaff(req, res);
  if (!auth) return;
  const messages = db.messages.map((m) => {
    const student = db.students.find((s) => s.studentId === m.studentId);
    return { ...m, studentName: student ? student.name : m.studentId, studentClass: student ? student.class : '' };
  });
  send(res, 200, { messages });
}

async function handleReplyMessage(req, res, studentId) {
  const auth = requireStaff(req, res);
  if (!auth) return;
  const { body } = await readBody(req);
  if (!body || !body.trim()) return send(res, 400, { error: 'Write a reply first.' });
  const student = db.students.find((s) => s.studentId === studentId);
  if (!student) return send(res, 404, { error: 'Student not found.' });
  const msg = {
    id: 'msg_' + crypto.randomBytes(4).toString('hex'),
    studentId,
    from: auth.name,
    to: 'Family',
    body: body.trim(),
    direction: 'out',
    time: new Date().toISOString(),
  };
  db.messages.push(msg);
  saveDB(db);
  send(res, 201, { message: msg });
}

function handleAdminStats(req, res) {
  const auth = requireStaff(req, res);
  if (!auth) return;
  const totalStudents = db.students.length;
  const avgStreak =
    Object.values(db.streaks).reduce((sum, arr) => sum + arr.length, 0) /
    Math.max(1, Object.keys(db.streaks).length);
  const messagesThisWeek = db.messages.length;
  const byClass = {};
  db.students.forEach((s) => {
    byClass[s.class] = (byClass[s.class] || 0) + (db.streaks[s.studentId] || []).length;
  });
  const topClass = Object.entries(byClass).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';
  send(res, 200, {
    totalStudents,
    avgStreak: Math.round(avgStreak * 10) / 10,
    messagesThisWeek,
    topClass,
    students: db.students.map((s) => ({
      name: s.name,
      class: s.class,
      points: s.points,
      streak: (db.streaks[s.studentId] || []).length,
    })),
  });
}

/* ------------------------------------------------------------------ */
/* materials (teacher uploads: video, audio, docs, worksheets, etc.)  */
/* ------------------------------------------------------------------ */

const TAG_EXT_HINT = { video: 'video', audio: 'audio', doc: 'application', worksheet: 'application', other: '' };

function classesVisibleTo(auth) {
  if (auth.type === 'staff') return null; // null = no filter, staff see everything
  if (auth.type === 'student') return [auth.class];
  if (auth.type === 'family') {
    return db.students.filter((s) => auth.studentIds.includes(s.studentId)).map((s) => s.class);
  }
  return [];
}

async function handleUploadMaterial(req, res) {
  const auth = requireStaff(req, res);
  if (!auth) return;
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(.+)$/);
  if (!boundaryMatch) return send(res, 400, { error: 'Expected a file upload (multipart form data).' });

  let raw;
  try {
    raw = await readRawBody(req, MAX_UPLOAD_BYTES);
  } catch (e) {
    return send(res, 413, { error: e.message || 'File is too large.' });
  }
  const { fields, files } = parseMultipart(raw, boundaryMatch[1]);
  const file = files.file;
  if (!file || !file.data.length) return send(res, 400, { error: 'Attach a file.' });

  const title = (fields.title || '').trim();
  const cls = (fields.class || '').trim();
  const tag = (fields.tag || 'other').trim();
  const description = (fields.description || '').trim();
  if (!title || !cls) return send(res, 400, { error: 'Provide a title and a class.' });

  const ext = path.extname(file.filename || '') || '';
  const storedName = 'mat_' + crypto.randomBytes(10).toString('hex') + ext;
  fs.writeFileSync(path.join(UPLOADS_DIR, storedName), file.data);

  const material = {
    id: 'mat_' + crypto.randomBytes(4).toString('hex'),
    title,
    class: cls,
    tag,
    description,
    fileName: file.filename || storedName,
    storedName,
    contentType: file.contentType || 'application/octet-stream',
    size: file.data.length,
    uploadedBy: auth.name,
    uploadedById: auth.id,
    createdAt: new Date().toISOString(),
  };
  db.materials.push(material);
  saveDB(db);
  send(res, 201, { material: { ...material, storedName: undefined } });
}

function handleListMaterials(req, res) {
  const auth = getAuth(req);
  if (!auth) return send(res, 401, { error: 'Log in to see materials.' });
  const allowed = classesVisibleTo(auth);
  const materials = db.materials
    .filter((m) => !allowed || allowed.includes(m.class))
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((m) => ({
      id: m.id,
      title: m.title,
      class: m.class,
      tag: m.tag,
      description: m.description,
      fileName: m.fileName,
      contentType: m.contentType,
      size: m.size,
      uploadedBy: m.uploadedBy,
      createdAt: m.createdAt,
      url: `/api/files/${m.storedName}`,
    }));
  send(res, 200, { materials });
}

function handleDeleteMaterial(req, res, id) {
  const auth = requireStaff(req, res);
  if (!auth) return;
  const material = db.materials.find((m) => m.id === id);
  if (!material) return send(res, 404, { error: 'Material not found.' });
  db.materials = db.materials.filter((m) => m.id !== id);
  saveDB(db);
  try { fs.unlinkSync(path.join(UPLOADS_DIR, material.storedName)); } catch {}
  send(res, 200, { ok: true });
}

function handleServeFile(req, res, storedName) {
  const auth = getAuth(req);
  if (!auth) return send(res, 401, { error: 'Log in to view this file.' });
  const material = db.materials.find((m) => m.storedName === storedName);
  if (!material) return send(res, 404, { error: 'File not found.' });
  const allowed = classesVisibleTo(auth);
  if (allowed && !allowed.includes(material.class)) {
    return send(res, 403, { error: "This material isn't available for your class." });
  }
  const filePath = path.join(UPLOADS_DIR, storedName);
  if (!fs.existsSync(filePath)) return send(res, 404, { error: 'File is missing on the server.' });
  const data = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': material.contentType,
    'Content-Length': data.length,
    'Content-Disposition': `inline; filename="${material.fileName.replace(/"/g, '')}"`,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'private, max-age=3600',
  });
  res.end(data);
}

function handleServeStudentPhoto(req, res, storedName) {
  const auth = requireStaff(req, res);
  if (!auth) return;
  const student = db.students.find((s) => s.photoUrl === `/api/student-photos/${storedName}`);
  if (!student) return send(res, 404, { error: 'Photo not found.' });
  const filePath = path.join(UPLOADS_DIR, storedName);
  if (!fs.existsSync(filePath)) return send(res, 404, { error: 'Photo is missing on the server.' });
  const data = fs.readFileSync(filePath);
  const contentType = path.extname(storedName).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': data.length,
    'Content-Disposition': 'inline',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'private, max-age=3600',
  });
  res.end(data);
}

function handleListLibrary(req, res) {
  const auth = getAuth(req);
  if (!auth) return send(res, 401, { error: 'Log in to see the digital library.' });

  const grade = auth.type === 'student'
    ? Number.parseInt(String(auth.class || '').match(/\d{1,2}/)?.[0] || '', 10)
    : null;
  const items = db.library
    .filter((item) => auth.type !== 'student' || item.gradeLevel === grade)
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  send(res, 200, { items });
}

/* ------------------------------------------------------------------ */
/* calendar (principal posts events; everyone logged in can view)     */
/* ------------------------------------------------------------------ */

async function handleCreateEvent(req, res) {
  const auth = requireStaff(req, res);
  if (!auth) return;
  if (auth.role !== 'principal') {
    return send(res, 403, { error: 'Only the principal can post calendar events.' });
  }
  const { title, date, time, description, audience } = await readBody(req);
  if (!title || !date) return send(res, 400, { error: 'Provide a title and a date.' });
  const event = {
    id: 'ev_' + crypto.randomBytes(4).toString('hex'),
    title: title.trim(),
    date,
    time: time || '',
    description: (description || '').trim(),
    audience: audience && audience.trim() ? audience.trim() : 'all',
    createdBy: auth.id,
    createdByName: auth.name,
    createdAt: new Date().toISOString(),
  };
  db.calendarEvents.push(event);
  saveDB(db);
  send(res, 201, { event });
}

function handleListEvents(req, res) {
  const auth = getAuth(req);
  if (!auth) return send(res, 401, { error: 'Log in to see the calendar.' });
  const allowed = classesVisibleTo(auth); // null for staff = see all
  const events = db.calendarEvents
    .filter((e) => e.audience === 'all' || !allowed || allowed.includes(e.audience))
    .slice()
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  send(res, 200, { events });
}

function handleDeleteEvent(req, res, id) {
  const auth = requireStaff(req, res);
  if (!auth) return;
  if (auth.role !== 'principal') return send(res, 403, { error: 'Only the principal can remove calendar events.' });
  const before = db.calendarEvents.length;
  db.calendarEvents = db.calendarEvents.filter((e) => e.id !== id);
  if (db.calendarEvents.length === before) return send(res, 404, { error: 'Event not found.' });
  saveDB(db);
  send(res, 200, { ok: true });
}

/**
 * Lightweight rule-based reply so the assistant panel works out of the box
 * with zero external calls. To wire a real Claude response instead, set
 * ANTHROPIC_API_KEY in the environment and see callClaude() below for a
 * ready-to-use stub (uses Node's built-in https — no SDK required).
 */
async function handleAssistant(req, res) {
  const auth = requireStudent(req, res);
  if (!auth) return;
  const { message } = await readBody(req);
  const todos = db.todos.filter((t) => t.studentId === auth.id);
  const openCount = todos.filter((t) => !t.done).length;

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const reply = await callClaude(message, todos);
      return send(res, 200, { reply });
    } catch (e) {
      // fall through to the rule-based reply below
    }
  }

  let reply;
  if (openCount === 0) {
    reply = "You've cleared everything on today's list — nice work. Want me to suggest something light to get ahead on tomorrow?";
  } else if (openCount === 1) {
    reply = 'Just one task left today. A focused 20-minute block should do it — want a timer?';
  } else {
    reply = `You've got ${openCount} tasks left today. Want me to help split the biggest one into smaller steps?`;
  }
  send(res, 200, { reply });
}

/**
 * Real Claude integration stub — no SDK dependency, just Node's https.
 * Requires ANTHROPIC_API_KEY to be set in the environment.
 */
function callClaude(userMessage, todos) {
  const https = require('https');
  const payload = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: `You are a friendly study assistant for a student. Their current task list: ${JSON.stringify(
          todos.map((t) => ({ text: t.text, done: t.done }))
        )}. The student says: "${userMessage}". Reply warmly in 1-3 short sentences.`,
      },
    ],
  });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            const text = parsed.content?.map((c) => c.text).filter(Boolean).join(' ') || '';
            resolve(text || "I'm here — tell me what you're working on.");
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* router                                                             */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const m = req.method;

  if (m === 'OPTIONS') return send(res, 204, {});

  try {
    if (m === 'POST' && p === '/api/auth/staff/login') return await handleStaffLogin(req, res);
    if (m === 'POST' && p === '/api/auth/student/login') return await handleStudentLogin(req, res);
    if (m === 'POST' && p === '/api/auth/family/login') return await handleFamilyLogin(req, res);
    if (m === 'POST' && p === '/api/staff/register-student') return await handleRegisterStudent(req, res);
    if (m === 'POST' && p === '/api/staff/register-family') return await handleRegisterFamily(req, res);
    if (m === 'GET' && p === '/api/staff/students') return handleListStudents(req, res);
    const studentDeleteMatch = p.match(/^\/api\/staff\/students\/([^/]+)$/);
    if (m === 'DELETE' && studentDeleteMatch) {
      return handleDeleteStudent(req, res, decodeURIComponent(studentDeleteMatch[1]));
    }
    if (m === 'GET' && p === '/api/staff/families') return handleListFamilies(req, res);
    if (m === 'GET' && p === '/api/staff/staff') return handleListStaff(req, res);
    if (m === 'GET' && p === '/api/me') return handleMe(req, res);

    if (m === 'GET' && p === '/api/todos') return handleGetTodos(req, res);
    if (m === 'POST' && p === '/api/todos') return await handleAddTodo(req, res);
    const toggleMatch = p.match(/^\/api\/todos\/([^/]+)$/);
    if (m === 'PATCH' && toggleMatch) return await handleToggleTodo(req, res, toggleMatch[1]);
    if (m === 'DELETE' && toggleMatch) return handleDeleteTodo(req, res, toggleMatch[1]);

    if (m === 'GET' && p === '/api/streak') return handleStreak(req, res);
    if (m === 'GET' && p === '/api/leaderboard') return handleLeaderboard(req, res);

    if (m === 'GET' && p === '/api/staff/messages') return handleStaffMessages(req, res);
    const replyMatch = p.match(/^\/api\/staff\/messages\/([^/]+)\/reply$/);
    if (m === 'POST' && replyMatch) return await handleReplyMessage(req, res, replyMatch[1]);

    if (m === 'GET' && p === '/api/family/messages') return handleFamilyMessages(req, res);
    if (m === 'POST' && p === '/api/family/messages') return await handleFamilySendMessage(req, res);

    if (m === 'GET' && p === '/api/admin/stats') return handleAdminStats(req, res);

    if (m === 'POST' && p === '/api/staff/materials') return await handleUploadMaterial(req, res);
    if (m === 'GET' && p === '/api/materials') return handleListMaterials(req, res);
    if (m === 'GET' && p === '/api/library') return handleListLibrary(req, res);
    const matDeleteMatch = p.match(/^\/api\/staff\/materials\/([^/]+)$/);
    if (m === 'DELETE' && matDeleteMatch) return handleDeleteMaterial(req, res, matDeleteMatch[1]);
    const fileMatch = p.match(/^\/api\/files\/([^/]+)$/);
    if (m === 'GET' && fileMatch) return handleServeFile(req, res, fileMatch[1]);
    const studentPhotoMatch = p.match(/^\/api\/student-photos\/([^/]+)$/);
    if (m === 'GET' && studentPhotoMatch) return handleServeStudentPhoto(req, res, studentPhotoMatch[1]);

    if (m === 'POST' && p === '/api/staff/calendar') return await handleCreateEvent(req, res);
    if (m === 'GET' && p === '/api/calendar') return handleListEvents(req, res);
    const evDeleteMatch = p.match(/^\/api\/staff\/calendar\/([^/]+)$/);
    if (m === 'DELETE' && evDeleteMatch) return handleDeleteEvent(req, res, evDeleteMatch[1]);

    if (m === 'POST' && p === '/api/assistant') return await handleAssistant(req, res);

    send(res, 404, { error: 'Not found.' });
  } catch (e) {
    send(res, 500, { error: 'Something went wrong on the server.', detail: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Studyo backend running at http://localhost:${PORT}`);
  console.log(`Demo principal login  -> staff ID: P-1001  password: admin123`);
  console.log(`Demo teacher login    -> staff ID: T-2001  password: teach123`);
  console.log(`Demo student login    -> student ID: S-3001  name: Selam Tesfaye`);
  console.log(`Demo family login     -> family ID: F-5001  password: family123`);
});
