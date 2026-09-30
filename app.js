/* ============================================================
   منصة مستر عادل عزت — منطق التطبيق
   الدخول بالأكواد، الشروحات، الامتحانات، المنتدى، ولوحة المستر
   ============================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

/* ---------- الاتصال بقاعدة البيانات ---------- */
const firebaseConfig = {
  apiKey: "AIzaSyClXTtircqJeKJkRTM7pBU5yexiAIld-98",
  authDomain: "clinic-nour.firebaseapp.com",
  projectId: "clinic-nour",
  storageBucket: "clinic-nour.firebasestorage.app",
  messagingSenderId: "43948752633",
  appId: "1:43948752633:web:ec7d3148df78e8700bec28"
};

let cloudAvailable = true;   // SDK اشتغل
let cloudBlocked = false;    // قواعد Firestore مش منشورة (permission denied)
let bootSyncDone = false;    // خلصت المزامنة الأولى
const hydratedCols = new Set(); // المجموعات اللي اتحمّلت من السحابة (تشترط قبل أي كتابة)
let app, firestoreDb;
// ==== البنية الجديدة: مجموعة لكل كيان (تزامن صحيح بين الأجهزة بدون last-write-wins) ====
const ENTITY_SORTS = {
  students: null, attendance: "date", quizzes: "date", submissions: "submittedAt",
  lessons: "date", forum: "createdAt", points: "at", rewards: null, redemptions: "at"
};
const ENTITIES = Object.keys(ENTITY_SORTS);
const colRef = (name) => collection(firestoreDb, "adel_" + name);
const itemRef = (name, id) => doc(firestoreDb, "adel_" + name, String(id));
const SETTINGS_REF = () => doc(firestoreDb, "adel_settings", "main");
const LEGACY_REF = () => doc(firestoreDb, "academy", "adelEzzat");
const BACKUP_REF = () => doc(firestoreDb, "academy", "adelEzzat_backup_v1");
try {
  app = initializeApp(firebaseConfig);
  firestoreDb = getFirestore(app);
} catch (e) {
  cloudAvailable = false;
}

const DEFAULT_DB = {
  students: [
    { code: "ADEL-3A-001", name: "طالب تجريبي", grade: "3A", phone: "" }
  ],
  attendance: [],
  quizzes: [],
  submissions: [],
  lessons: [
    {
      id: "lesson_demo_1",
      title: "Unit 1: Present Perfect",
      desc: "شرح زمن المضارع التام مع أمثلة وتدريبات.",
      date: "2026-09-20",
      videos: [],
      body: "في الدرس ده هنشرح Present Perfect:\n- التكوين: have / has + V3\n- الاستخدامات: حدوث حاجة في الماضي ولسه مفعولها موجود، تجارب الحياة، ونتيجة مرئية دلوقتي.\n- كلمات دالة: just, already, yet, ever, never, since, for."
    }
  ],
  forum: [],
  points: [],
  rewards: [
    { id: "rw_1", name: "+5 درجات في كويز", cost: 80, emoji: "✏️" },
    { id: "rw_2", name: "سماح من الواجب مرة واحدة", cost: 120, emoji: "🤝" },
    { id: "rw_3", name: "اختيار لعبة للحصة", cost: 200, emoji: "🎮" }
  ],
  redemptions: [],
  settings: { teacherPass: "adel2026", whatsapp: "", banner: "", aiKey: "", aiModel: "gemini-2.5-flash" }
};

let db = JSON.parse(JSON.stringify(DEFAULT_DB));
let me = null;          // الطالب الحالي {code,name,grade,phone}
let teacherUnlocked = false;
let currentTab = "home";
let currentQuiz = null; // {quiz, answers}
let currentThread = null;
let cloudErrorShown = false;
let rulesDeniedToastShown = false;

/* ---------- أدوات ---------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => {
  if (s === null || s === undefined) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
};
const uid = (p) => p + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
const todayStr = () => new Date().toISOString().slice(0, 10);
const prettyDate = (iso) => {
  try {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("ar-EG", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  } catch { return iso; }
};
const dateTime = (ts) => {
  try { return new Date(ts).toLocaleString("ar-EG", { dateStyle: "medium", timeStyle: "short" }); }
  catch { return ""; }
};

/* ---------- أدوات التخزين: مجموعة Firestore لكل كيان + تطبيع البيانات ---------- */
function normalizeSettings(s) {
  return Object.assign({}, DEFAULT_DB.settings, s || {});
}
function normalizeList(name, arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const key = String(it.id || (name === "students" ? it.code : ""));
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(it);
  }
  const sortKey = ENTITY_SORTS[name];
  if (sortKey) out.sort((a, b) => (a[sortKey] || 0) - (b[sortKey] || 0));
  return out;
}
function applyLists(lists) {
  for (const name of ENTITIES) {
    if (Array.isArray(lists[name])) db[name] = normalizeList(name, lists[name]);
  }
  // البيانات جاية من السحابة = محفوظة بالفعل
  for (const name of ENTITIES) markAllSaved(name);
}

async function readCollection(name) {
  const snap = await getDocs(colRef(name));
  const rows = [];
  snap.forEach((d) => { const v = d.data(); if (v && typeof v === "object") rows.push(v); });
  return rows;
}

async function cloudWriteSettings() {
  await setDoc(SETTINGS_REF(), db.settings);
  savedSnapshot.set("@settings", JSON.stringify(db.settings));
}
// تجاهل كتابة العناصر اللي اتغيرتش — توفير كبير في عمليات الكتابة
const savedSnapshot = new Map();
function markAllSaved(name) {
  for (const item of db[name]) {
    const id = String(item.id || item.code || "");
    if (id) savedSnapshot.set(name + "/" + id, JSON.stringify(item));
  }
}
async function cloudWriteList(name) {
  const ref = colRef(name);
  for (const item of db[name]) {
    const id = String(item.id || item.code || uid(name.slice(0, 2)));
    const json = JSON.stringify(item);
    const k = name + "/" + id;
    if (savedSnapshot.get(k) === json) continue; // متغيرش → متكتبش
    await setDoc(doc(ref, id), item);
    savedSnapshot.set(k, json);
  }
}
async function cloudWriteAll() {
  for (const name of ENTITIES) {
    await cloudWriteList(name);
    hydratedCols.add(name);
  }
  await cloudWriteSettings();
}

async function cloudDelete(name, id) {
  try { await deleteDoc(itemRef(name, String(id))); } catch (e) { showSave(false, String((e && e.message) || e)); }
}

function showSave(ok, detail) {
  if (ok) return;
  if (!cloudAvailable && !cloudErrorShown) {
    cloudErrorShown = true;
    toast("⚠ وضع بدون إنترنت: البيانات محفوظة محلياً على الجهاز ده بس.");
  }
  if (cloudBlocked && !rulesDeniedToastShown) {
    rulesDeniedToastShown = true;
    toast("⚠ قواعد قاعدة البيانات مش منشورة — اتبع خطوات README لنشرها عشان المزامنة تشتغل.");
  }
}
function toast(msg) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 400); }, 3500);
}

async function migrateLegacyDoc() {
  // نقل بيانات النسخة القديمة (المستند الواحد academy/adelEzzat) للمجموعات الجديدة — مرة واحدة
  let legacy = null;
  try { const s = await getDoc(LEGACY_REF()); if (s.exists()) legacy = s.data(); } catch (e) { return false; }
  if (!legacy || legacy.migrated) return false;
  let touched = false;
  for (const name of ENTITIES) {
    const arr = legacy[name];
    if (Array.isArray(arr) && arr.length && db[name].length === 0) {
      db[name] = normalizeList(name, arr);
      touched = true;
    }
  }
  if (legacy.settings && typeof legacy.settings === "object") {
    db.settings = normalizeSettings(Object.assign({}, legacy.settings));
    touched = true;
  }
  if (touched) await cloudWriteAll();
  // أرشفة النسخة القديمة بدل حذفها (أمان)
  try { await setDoc(BACKUP_REF(), legacy); await setDoc(LEGACY_REF(), { migrated: true, migratedAt: Date.now() }); } catch (e) {}
  return true;
}

async function loadDB() {
  // السحابة هي مصدر الحقيقة دايماً — localStorage للعرض الفوري فقط ولا يُقرأ كبيانات
  if (cloudAvailable) {
    try {
      const lists = {};
      for (const name of ENTITIES) lists[name] = await readCollection(name);
      let s = null;
      try { const snap = await getDoc(SETTINGS_REF()); if (snap.exists()) s = snap.data(); } catch (e) {}
      const cloudHasData = ENTITIES.some((n) => lists[n].length > 0) || !!s;
      if (!cloudHasData) {
        const migrated = await migrateLegacyDoc();
        if (!migrated) await cloudWriteAll();
      } else {
        applyLists(lists);
        if (s) db.settings = normalizeSettings(s);
        ENTITIES.forEach((n) => hydratedCols.add(n));
      }
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/permission|denied|insufficient/i.test(msg)) {
        cloudBlocked = true;
      } else {
        cloudAvailable = false;
      }
      if (!cloudErrorShown) {
        cloudErrorShown = true;
        toast(cloudBlocked
          ? "⚠ قواعد قاعدة البيانات مش منشورة — المزامنة مش هتشتغل لحد ما تُنشر (خطوات README)."
          : "⚠ تعذر الاتصال بقاعدة البيانات — هيشتغل وضع محلي مؤقت.");
      }
    }
  }
  bootSyncDone = true;
}

async function saveDB(lists) {
  // كتابة ذرية لكل عنصر في مجموعته — مفيش كتابة شاملة ومفيش إمكانية إن جهاز يكتب فوق جهاز تاني
  const targets = Array.isArray(lists) && lists.length ? lists.slice() : ENTITIES.slice();
  if (cloudAvailable && !cloudBlocked) {
    try {
      if (targets.includes("settings")) {
        targets.splice(targets.indexOf("settings"), 1);
        await cloudWriteSettings();
      }
      for (const name of targets) {
        if (!ENTITIES.includes(name)) continue;
        await cloudWriteList(name);
        hydratedCols.add(name);
      }
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/permission|denied|insufficient/i.test(msg)) cloudBlocked = true;
      showSave(false, msg);
    }
  } else {
    showSave(false);
  }
  try { localStorage.setItem("adel_db", JSON.stringify(db)); } catch (e) {}
}
function touchLocal() {
  try { localStorage.setItem("adel_db", JSON.stringify(db)); } catch (e) {}
}

function watchCloud() {
  // تحديث حي: أي تغيير من جهاز تاني بيظهر فوراً على الشاشة دي
  if (!cloudAvailable || cloudBlocked) return;
  for (const name of ENTITIES) {
    onSnapshot(colRef(name), (snap) => {
      if (!bootSyncDone) return;
      const rows = [];
      snap.forEach((d) => { const v = d.data(); if (v && typeof v === "object") rows.push(v); });
      const before = JSON.stringify(db[name]);
      db[name] = normalizeList(name, rows);
      if (JSON.stringify(db[name]) === before) return;
      markAllSaved(name);
      if (me) {
        renderHeaderPoints();
        if (currentTab === "home") { renderStudentStats(); renderHomeLessons(); renderHomeForum(); renderHomeLeaderboard(); }
        if (currentTab === "leaderboard") renderLeaderboard();
        if (currentTab === "quizzes") renderQuizList();
        if (currentTab === "forum") renderForum();
      }
      const ae = document.activeElement;
      const typing = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT");
      if (teacherUnlocked && !typing && !$("teacherContainer").classList.contains("hidden")) renderTeacher();
    }, () => {});
  }
  onSnapshot(SETTINGS_REF(), (snap) => {
    if (!bootSyncDone || !snap.exists()) return;
    db.settings = normalizeSettings(snap.data());
    if (me) renderBanner();
  }, () => {});
}

/* ---------- التنقل العام ---------- */
function show(view) {
  ["loginView", "studentView", "teacherView"].forEach((v) => $(v).classList.add("hidden"));
  $(view).classList.remove("hidden");
  window.scrollTo(0, 0);
}

/* ---------- شاشة الدخول ---------- */
async function doLogin() {
  const raw = $("accessCodeInput").value.trim().toUpperCase();
  const err = $("loginError");
  err.style.display = "none";
  if (!raw) { err.textContent = "اكتب كود الدخول الأول."; err.style.display = "block"; return; }

  const st = db.students.find((s) => String(s.code).trim().toUpperCase() === raw);
  if (!st) {
    err.textContent = "الكود ده مش موجود. اتأكد منه أو كلم مستر عادل.";
    err.style.display = "block";
    return;
  }
  me = st;
  try { sessionStorage.setItem("adel_me", JSON.stringify(st)); } catch {}
  openStudent();
}

function resumeSession() {
  try {
    const raw = sessionStorage.getItem("adel_me");
    if (!raw) return false;
    const st = JSON.parse(raw);
    if (!st || !st.code) return false;
    const found = db.students.find((s) => String(s.code).trim().toUpperCase() === String(st.code).trim().toUpperCase());
    if (!found) return false;
    me = found;
    openStudent();
    return true;
  } catch { return false; }
}

function studentLogout() {
  me = null;
  try { sessionStorage.removeItem("adel_me"); } catch {}
  show("loginView");
  $("accessCodeInput").value = "";
}

/* ============================================================
   واجهة الطالب
   ============================================================ */
function openStudent() {
  show("studentView");
  $("studentBadge").textContent = me.name + " — " + me.grade;
  $("welcomeName").textContent = "أهلاً يا " + me.name.split(" ")[0] + " 👋";
  $("welcomeMeta").textContent = "فصل " + me.grade + " • كودك: " + me.code;
  $("streakBox").innerHTML = attendanceStreakHTML();
  renderBanner();
  renderHeaderPoints();
  renderPointsBar();
  renderStudentStats();
  renderHomeLessons();
  renderHomeForum();
  renderHomeLeaderboard();
  switchTab("home");
}

function renderBanner() {
  const box = $("bannerBox");
  const txt = (db.settings && db.settings.banner) ? String(db.settings.banner).trim() : "";
  if (!txt) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.classList.remove("hidden");
  box.className = "notice gold";
  box.innerHTML = "📢 " + esc(txt);
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll("#studentTabs .tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
  $("tab-" + tab).classList.remove("hidden");
  if (tab === "lessons") renderLessons();
  if (tab === "quizzes") renderQuizList();
  if (tab === "forum") renderForum();
  if (tab === "leaderboard") renderLeaderboard();
  if (tab === "ai") initAI();
  if (tab === "profile") renderProfile();
}

function myAttendance() {
  return db.attendance.filter((a) => a.code === me.code);
}
function mySubmissions() {
  return db.submissions.filter((s) => s.code === me.code);
}
function attendanceStreakHTML() {
  const dates = [...new Set(myAttendance().filter((a) => a.present).map((a) => a.date))].sort();
  if (!dates.length) return "<b>0</b>حضور";
  // عدّي المتتابع لآخر مواعيد الحضور
  const dayMs = 86400000;
  let streak = 1;
  const toT = (s) => new Date(s + "T00:00:00").getTime();
  const todays = toT(todayStr());
  let prev = toT(dates[dates.length - 1]);
  if (todays - prev > dayMs * 7) return "<b>0</b>حضور";
  for (let i = dates.length - 2; i >= 0; i--) {
    const t = toT(dates[i]);
    if (prev - t === dayMs * 7 || prev - t === dayMs) { streak++; prev = t; }
    else break;
  }
  return "<b>" + streak + "</b>حضور متواصل";
}

function renderStudentStats() {
  const subs = mySubmissions();
  const attended = myAttendance().filter((a) => a.present).length;
  const avg = subs.length
    ? Math.round(subs.reduce((s, x) => s + (x.score / Math.max(1, x.max)) * 100, 0) / subs.length)
    : 0;
  const stats = [
    { n: db.lessons.length, l: "درس متاح" },
    { n: db.quizzes.length, l: "امتحان/كويز" },
    { n: subs.length, l: "امتحان اتحل" },
    { n: avg + "%", l: "متوسط الدرجات" },
    { n: attended, l: "حضور" }
  ];
  $("studentStats").innerHTML = stats.map((s) =>
    '<div class="stat-card"><b>' + esc(String(s.n)) + '</b><span>' + esc(s.l) + '</span></div>'
  ).join("");
}

function renderHomeLessons() {
  const list = db.lessons.slice(-3).reverse();
  $("homeLessons").innerHTML = list.map(lessonCardHTML).join("") ||
    '<div class="muted">لسه مفيش شروحات منورة.</div>';
}
function lessonCardHTML(l) {
  return '<div class="lesson-card" data-lesson="' + esc(l.id) + '">' +
    '<div class="lesson-icon">📘</div>' +
    '<div class="lesson-title">' + esc(l.title) + '</div>' +
    '<div class="lesson-desc">' + esc(l.desc || "") + '</div>' +
    '<div class="chips"><span class="chip">' + esc(l.date || "") + '</span>' +
    (l.videos && l.videos.length ? '<span class="chip blue">🎬 ' + l.videos.length + ' فيديو</span>' : '') +
    '</div></div>';
}
function renderHomeForum() {
  const list = db.forum.slice(-4).reverse();
  $("homeForum").innerHTML = list.map((t) =>
    '<div class="forum-item" data-thread="' + esc(t.id) + '">' +
    '<h4>' + esc(t.title) + '</h4>' +
    '<div class="forum-meta"><span>👤 ' + esc(t.author) + '</span>' +
    '<span>💬 ' + (t.replies ? t.replies.length : 0) + ' رد</span>' +
    '<span>' + esc(dateTime(t.createdAt)) + '</span></div></div>'
  ).join("") || '<div class="muted">المنتدى لسه هادي — كون أول واحد يكتب موضوع!</div>';
}

/* ---------- الشروحات ---------- */
function renderLessons() {
  $("lessonViewer").classList.add("hidden");
  $("lessonViewer").innerHTML = "";
  $("lessonsList").classList.remove("hidden");
  const list = db.lessons.slice().reverse();
  $("lessonsList").innerHTML = list.map(lessonCardHTML).join("") ||
    '<div class="muted">لسه مفيش شروحات — المستر هيضيف قريب.</div>';
  $("lessonsList").querySelectorAll("[data-lesson]").forEach((el) => {
    el.addEventListener("click", () => openLesson(el.dataset.lesson));
  });
}

function openLesson(id) {
  const l = db.lessons.find((x) => x.id === id);
  if (!l) return;
  $("lessonsList").classList.add("hidden");
  const v = $("lessonViewer");
  v.classList.remove("hidden");
  v.innerHTML =
    '<div class="card">' +
    '<button class="btn tiny ghost" id="backToLessons">← رجوع للشروحات</button>' +
    '<h3 class="section-title" style="margin-top:12px;">' + esc(l.title) + '</h3>' +
    '<div class="chips" style="margin-bottom:10px;"><span class="chip">' + esc(l.date || "") + '</span></div>' +
    '<div style="white-space:pre-wrap;font-size:14.5px;">' + esc(l.body || "لا يوجد شرح مكتوب لهذا الدرس.") + '</div>' +
    (l.videos && l.videos.length ?
      '<h3 class="section-title">المحاضرات المرئية</h3><div class="chips">' +
      l.videos.map((vid, i) =>
        '<button class="btn gold" data-video="' + esc(vid) + '">▶ الفيديو ' + (i + 1) + '</button>'
      ).join(" ") + '</div>' : '') +
    '</div>';
  $("backToLessons").addEventListener("click", renderLessons);
  v.querySelectorAll("[data-video]").forEach((b) => {
    b.addEventListener("click", () => openVideo(b.dataset.video, l.title));
  });
}

function youtubeId(input) {
  const m = String(input).match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : String(input).trim();
}
function openVideo(raw, title) {
  const id = youtubeId(raw);
  const modal = $("videoModal");
  modal.classList.remove("hidden");
  modal.innerHTML =
    '<div class="modal-inner">' +
    '<div class="modal-bar"><b>🎬 ' + esc(title) + '</b>' +
    '<button class="btn tiny" id="closeVideo">إغلاق ✕</button></div>' +
    '<iframe src="https://www.youtube.com/embed/' + esc(id) + '" allowfullscreen allow="autoplay; encrypted-media"></iframe>' +
    '</div>';
  $("closeVideo").addEventListener("click", closeVideo);
}
function closeVideo() {
  const modal = $("videoModal");
  modal.classList.add("hidden");
  modal.innerHTML = "";
}

/* ---------- الامتحانات ---------- */
function renderQuizList() {
  $("quizTaking").classList.add("hidden");
  $("quizTaking").innerHTML = "";
  $("quizListWrap").classList.remove("hidden");
  const list = db.quizzes.slice().reverse();
  $("quizList").innerHTML = list.map((q) => {
    const sub = mySubmissions().find((s) => s.quizId === q.id);
    const chip = sub
      ? '<span class="chip green">اتحل: ' + sub.score + '/' + q.questions.length + '</span>'
      : '<span class="chip">' + q.questions.length + ' سؤال</span>';
    return '<div class="quiz-card" data-quiz="' + esc(q.id) + '">' +
      '<div class="lesson-icon">' + (sub ? "✅" : "📝") + '</div>' +
      '<div class="lesson-title">' + esc(q.title) + '</div>' +
      '<div class="lesson-desc">' + esc(q.desc || "") + '</div>' +
      '<div class="chips">' + chip + '<span class="chip gray">' + esc(q.date || "") + '</span></div></div>';
  }).join("") || '<div class="muted">مفيش امتحانات لسه — طلّم على مستر يضيف واحدة 😄</div>';
  $("quizList").querySelectorAll("[data-quiz]").forEach((el) => {
    el.addEventListener("click", () => openQuiz(el.dataset.quiz));
  });
}

function openQuiz(id) {
  const q = db.quizzes.find((x) => x.id === id);
  if (!q) return;
  const sub = mySubmissions().find((s) => s.quizId === id);
  if (sub) { renderQuizResult(sub, q); return; }
  currentQuiz = { quiz: q, answers: new Array(q.questions.length).fill(null) };
  $("quizListWrap").classList.add("hidden");
  const t = $("quizTaking");
  t.classList.remove("hidden");
  t.innerHTML =
    '<div class="card">' +
    '<button class="btn tiny ghost" id="backToQuizzes">← رجوع للقائمة</button>' +
    '<h3 class="section-title" style="margin-top:12px;">📝 ' + esc(q.title) + '</h3>' +
    '<p class="muted">' + esc(q.desc || "") + '</p>' +
    '<div id="quizQuestions"></div>' +
    '<button class="btn primary block" id="submitQuizBtn">تسليم الامتحان</button>' +
    '</div>';
  $("backToQuizzes").addEventListener("click", renderQuizList);
  renderQuizQuestions();
  $("submitQuizBtn").addEventListener("click", submitQuiz);
}

function renderQuizQuestions() {
  const { quiz, answers } = currentQuiz;
  $("quizQuestions").innerHTML = quiz.questions.map((qq, qi) =>
    '<div class="quiz-question">' +
    '<div class="q-text">' + (qi + 1) + '. ' + esc(qq.q) + '</div>' +
    qq.choices.map((c, ci) =>
      '<label class="choice' + (answers[qi] === ci ? " picked" : "") + '" data-q="' + qi + '" data-c="' + ci + '">' + esc(c) + '</label>'
    ).join("") +
    '</div>'
  ).join("");
  $("quizQuestions").querySelectorAll(".choice").forEach((el) => {
    el.addEventListener("click", () => {
      currentQuiz.answers[el.dataset.q] = Number(el.dataset.c);
      renderQuizQuestions();
    });
  });
}

function submitQuiz() {
  const { quiz, answers } = currentQuiz;
  if (answers.some((a) => a === null)) {
    toast("لسه في أسئلة محلولةش — جاوب كل الأسئلة الأول.");
    return;
  }
  let score = 0;
  const review = quiz.questions.map((qq, qi) => {
    const ok = answers[qi] === qq.correct;
    if (ok) score++;
    return { q: qq.q, picked: answers[qi], correct: qq.correct, ok };
  });
  const sub = {
    id: uid("sub"), quizId: quiz.id, code: me.code, name: me.name, grade: me.grade,
    score, max: quiz.questions.length, submittedAt: Date.now(), review
  };
  db.submissions.push(sub);
  const earned = score * 2 + (score === quiz.questions.length ? 5 : 0);
  awardPoints(me.code, me.name, earned, "كويز: " + quiz.title + " (" + score + "/" + quiz.questions.length + ")");
  saveDB(["submissions", "points"]);
  currentQuiz = null;
  renderQuizResult(sub, quiz, earned);
  renderHeaderPoints();
  renderPointsBar();
  renderStudentStats();
}

function renderQuizResult(sub, quiz, earned) {
  $("quizListWrap").classList.add("hidden");
  const t = $("quizTaking");
  t.classList.remove("hidden");
  const pct = Math.round((sub.score / Math.max(1, sub.max)) * 100);
  const msg = pct >= 85 ? "ممتاز! 👏" : pct >= 65 ? "كويس جداً، كمّل!" : pct >= 50 ? "لايق تحسين 💪" : "محتاج مراجعة الدرس تاني 📖";
  const reviewHTML = (sub.review || []).map((r, i) => {
    const qq = quiz.questions[i];
    if (!qq) return "";
    const choicesHTML = (qq.choices || []).map((c, ci) => {
      const isCorrect = ci === qq.correct;
      const isPicked = ci === r.picked && !r.ok;
      return '<div class="choice' + (isCorrect ? " correct" : isPicked ? " wrong" : "") + '">' +
        esc(c) + (isCorrect ? " ← الإجابة الصح" : isPicked ? " ← اختيارك" : "") + '</div>';
    }).join("");
    return '<div class="quiz-question"><div class="q-text">' + (i + 1) + '. ' + esc(r.q) +
      ' <span class="' + (r.ok ? "q-result-ok" : "q-result-no") + '">' + (r.ok ? "✓ صح" : "✗ غلط") + '</span></div>' +
      choicesHTML + '</div>';
  }).join("");

  t.innerHTML =
    '<div class="card">' +
    '<button class="btn tiny ghost" id="backToQuizzes2">← رجوع للقائمة</button>' +
    '<div class="score-hero"><div>نتيجتك في ' + esc(quiz.title) + '</div>' +
    '<div class="big">' + sub.score + ' / ' + sub.max + '</div>' +
    '<div>' + esc(msg) + '</div>' +
    (earned ? '<div class="earned">+' + earned + ' ⭐ اتضافت لرصيد نقطك</div>' : '') +
    '</div>' +
    '<h3 class="section-title">مراجعة الأسئلة</h3>' +
    reviewHTML +
    '</div>';
  $("backToQuizzes2").addEventListener("click", renderQuizList);
}

/* ---------- المنتدى ---------- */
function renderForum() {
  $("threadView").classList.add("hidden");
  $("threadView").innerHTML = "";
  $("forumList").classList.remove("hidden");
  $("newPostBtn").classList.remove("hidden");
  const list = db.forum.slice().reverse();
  $("forumList").innerHTML = list.map((t) =>
    '<div class="forum-item" data-thread="' + esc(t.id) + '">' +
    '<h4>' + esc(t.title) + '</h4>' +
    '<div class="forum-meta"><span>👤 ' + esc(t.author) + ' (' + esc(t.grade || "") + ')</span>' +
    '<span>💬 ' + (t.replies ? t.replies.length : 0) + ' رد</span>' +
    '<span>' + esc(dateTime(t.createdAt)) + '</span></div></div>'
  ).join("") || '<div class="muted">مفيش مواضيع — افتح الموضوع الأول!</div>';
  $("forumList").querySelectorAll("[data-thread]").forEach((el) => {
    el.addEventListener("click", () => openThread(el.dataset.thread));
  });
}

function openThread(id) {
  const t = db.forum.find((x) => x.id === id);
  if (!t) return;
  currentThread = id;
  $("forumList").classList.add("hidden");
  $("newPostBtn").classList.add("hidden");
  $("newPostForm").classList.add("hidden");
  const v = $("threadView");
  v.classList.remove("hidden");
  v.innerHTML =
    '<div class="card">' +
    '<button class="btn tiny ghost" id="backToForum">← رجوع للمنتدى</button>' +
    '<h3 class="section-title" style="margin-top:12px;">' + esc(t.title) + '</h3>' +
    '<div class="forum-meta" style="margin-bottom:10px;"><span>👤 ' + esc(t.author) + '</span><span>' + esc(dateTime(t.createdAt)) + '</span></div>' +
    '<div style="white-space:pre-wrap;">' + esc(t.body) + '</div>' +
    '</div>' +
    '<h3 class="section-title">الردود (' + (t.replies ? t.replies.length : 0) + ')</h3>' +
    '<div id="repliesBox"></div>' +
    '<div class="card form-card"><div class="field"><label>ردك</label>' +
    '<textarea id="replyBody" rows="3" placeholder="اكتب ردك هنا..."></textarea></div>' +
    '<div class="form-actions"><button class="btn primary" id="sendReply">إرسال الرد</button></div></div>';
  $("backToForum").addEventListener("click", renderForum);
  renderReplies(t);
  $("sendReply").addEventListener("click", () => {
    const body = $("replyBody").value.trim();
    if (!body) { toast("اكتب الرد الأول."); return; }
    t.replies = t.replies || [];
    t.replies.push({ id: uid("rep"), author: me.name, code: me.code, body, createdAt: Date.now() });
    saveDB(["forum"]);
    openThread(id);
    toast("✓ تم نشر ردك");
  });
}

function renderReplies(t) {
  const box = $("repliesBox");
  box.innerHTML = (t.replies || []).map((r) =>
    '<div class="reply' + (r.code === me.code ? " mine" : "") + '">' +
    '<div class="reply-head"><b>' + esc(r.author) + '</b><span>' + esc(dateTime(r.createdAt)) + '</span></div>' +
    '<div style="white-space:pre-wrap;font-size:14px;">' + esc(r.body) + '</div></div>'
  ).join("") || '<div class="muted">مفيش ردود بعد.</div>';
}

function toggleNewPostForm() {
  $("newPostForm").classList.toggle("hidden");
}

async function submitNewPost() {
  const title = $("newPostTitle").value.trim();
  const body = $("newPostBody").value.trim();
  if (!title || !body) { toast("اكتب العنوان والسؤال."); return; }
  db.forum.push({
    id: uid("th"), title, body, author: me.name, code: me.code, grade: me.grade,
    createdAt: Date.now(), replies: []
  });
  if (db.forum.filter((t) => t.code === me.code).length === 1) {
    awardPoints(me.code, me.name, 5, "أول موضوع في المنتدى 🎉");
  }
  await saveDB(["forum", "points"]);
  $("newPostTitle").value = "";
  $("newPostBody").value = "";
  $("newPostForm").classList.add("hidden");
  renderForum();
  toast("✓ تم نشر الموضوع");
}

/* ---------- ملفي ---------- */
function renderProfile() {
  const subs = mySubmissions();
  const att = myAttendance();
  const present = att.filter((a) => a.present).length;
  const avg = subs.length
    ? Math.round(subs.reduce((s, x) => s + (x.score / Math.max(1, x.max)) * 100, 0) / subs.length)
    : 0;
  $("profileStats").innerHTML =
    '<div class="stat-card"><b class="gold-num">' + pointsOf(me.code) + '</b><span>رصيد النقط ⭐</span></div>' +
    '<div class="stat-card"><b>' + rankOf(pointsOf(me.code)).icon + " " + esc(rankOf(pointsOf(me.code)).name) + '</b><span>الرتبة</span></div>' +
    '<div class="stat-card"><b>' + subs.length + '</b><span>امتحانات محسومة</span></div>' +
    '<div class="stat-card"><b>' + avg + '%</b><span>متوسط الدرجات</span></div>' +
    '<div class="stat-card"><b>' + present + '/' + att.length + '</b><span>نسبة الحضور</span></div>';

  $("gradesTable").innerHTML = subs.length ?
    '<div class="table-wrap"><table><tr><th>الامتحان</th><th>الدرجة</th><th>التاريخ</th></tr>' +
    subs.slice().reverse().map((s) => {
      const q = db.quizzes.find((x) => x.id === s.quizId);
      return '<tr><td>' + esc(q ? q.title : "امتحان") + '</td><td><b>' + s.score + '/' + s.max + '</b></td><td>' + esc(dateTime(s.submittedAt)) + '</td></tr>';
    }).join("") + '</table></div>'
    : '<div class="muted">لسه ماسلمتش أي امتحان.</div>';

  $("attendanceTable").innerHTML = att.length ?
    '<div class="table-wrap"><table><tr><th>الحصة</th><th>الحالة</th></tr>' +
    att.slice().reverse().map((a) =>
      '<tr><td>' + esc(prettyDate(a.date)) + '</td><td class="' + (a.present ? "present" : "absent") + '">' + (a.present ? "حاضر ✓" : "غائب ✗") + '</td></tr>'
    ).join("") + '</table></div>'
    : '<div class="muted">لسه مفيش سجل حضور.</div>';
}

/* ============================================================
   نظام النقط والرتب
   ============================================================ */
const RANKS = [
  { name: "مبتدئ", min: 0, icon: "🌱" },
  { name: "مجتهد", min: 50, icon: "📘" },
  { name: "متميز", min: 150, icon: "⭐" },
  { name: "نجم الفصل", min: 300, icon: "🌟" },
  { name: "أسطورة الإنجليزي", min: 500, icon: "👑" }
];
function rankOf(pts) {
  let r = RANKS[0];
  for (const rk of RANKS) if (pts >= rk.min) r = rk;
  return r;
}
function nextRankOf(pts) {
  for (const rk of RANKS) if (pts < rk.min) return rk;
  return null;
}
function pointsOf(code) {
  return db.points.filter((p) => p.code === code).reduce((s, p) => s + p.amount, 0);
}
function awardPoints(code, name, amount, reason) {
  if (!amount) return;
  db.points.push({ id: uid("pt"), code, name, amount, reason, at: Date.now() });
}
function renderHeaderPoints() {
  const el = $("studentBadge");
  if (!el || !me) return;
  const pts = pointsOf(me.code);
  el.innerHTML = esc(me.name + " — " + me.grade) + ' <span class="pts">• ' + pts + ' ⭐</span>';
}
function renderPointsBar() {
  const bar = $("pointsBar");
  if (!bar || !me) return;
  const pts = pointsOf(me.code);
  const rank = rankOf(pts);
  const next = nextRankOf(pts);
  const from = rank.min;
  const pct = next ? Math.min(100, Math.round(((pts - from) / (next.min - from)) * 100)) : 100;
  bar.innerHTML =
    '<div class="wallet"><span class="coin">⭐</span><span>' + pts + ' نقطة</span></div>' +
    '<span class="rank-chip">' + rank.icon + " " + esc(rank.name) + '</span>' +
    (next
      ? '<div class="progress-track"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
        '<span class="to-next">باقي ' + (next.min - pts) + ' نقطة لرتبة ' + next.icon + " " + esc(next.name) + '</span>'
      : '<span class="to-next">وصلت لأعلى رتبة! 🎉</span>');
}

function rankedStudents() {
  return db.students
    .map((s) => ({ code: s.code, name: s.name, grade: s.grade, pts: pointsOf(s.code) }))
    .sort((a, b) => b.pts - a.pts);
}
function renderHomeLeaderboard() {
  const box = $("homeLeaderboard");
  if (!box) return;
  const top = rankedStudents().slice(0, 5);
  box.innerHTML = top.length
    ? '<table><tr><th>#</th><th>الطالب</th><th>الرتبة</th><th>النقط</th></tr>' +
      top.map((s, i) => {
        const r = rankOf(s.pts);
        return '<tr class="rank-' + (i + 1) + '"><td class="rank-cell">' + (i + 1) + '</td><td><b>' + esc(s.name) + '</b> — ' + esc(s.grade) + '</td><td>' + r.icon + " " + esc(r.name) + '</td><td><b>' + s.pts + '</b> ⭐</td></tr>';
      }).join("") + '</table>'
    : '<div class="muted" style="padding:14px;">لسه مفيش نقط — ابدأ اكسب!</div>';
}
function renderLeaderboard() {
  const all = rankedStudents();
  const medals = ["🥇", "🥈", "🥉"];
  const heights = ["120px", "90px", "74px"];
  const order = [1, 0, 2]; // تاني، أول، تالت (شكل البوديوم)
  let podiumHTML = "";
  order.forEach((idx) => {
    const s = all[idx];
    if (!s) return;
    podiumHTML += '<div class="podium-slot p' + (idx + 1) + '">' +
      '<span class="slot-medal">' + medals[idx] + '</span>' +
      '<div class="slot-name">' + esc(s.name) + '</div>' +
      '<div class="slot-pts">' + s.pts + ' ⭐</div>' +
      '<div class="slot-bar" style="height:' + heights[idx] + '"></div></div>';
  });
  $("leaderboardPodium").innerHTML = podiumHTML || '<div class="muted">لسه مفيش منافسين!</div>';

  $("leaderboardTable").innerHTML = all.length
    ? '<table><tr><th>#</th><th>الطالب</th><th>الفصل</th><th>الرتبة</th><th>النقط</th></tr>' +
      all.map((s, i) => {
        const r = rankOf(s.pts);
        return '<tr class="rank-' + (i + 1) + '"><td class="rank-cell">' + (i + 1) + '</td><td><b>' + esc(s.name) + '</b></td><td>' + esc(s.grade) + '</td><td>' + r.icon + " " + esc(r.name) + '</td><td><b>' + s.pts + '</b> ⭐</td></tr>';
      }).join("") + '</table>'
    : '<div class="muted" style="padding:14px;">لسه مفيش طلاب.</div>';

  renderRewards();
}

function renderRewards() {
  const wrap = $("rewardsList");
  if (!wrap || !me) return;
  const pts = pointsOf(me.code);
  const mine = db.redemptions.filter((r) => r.code === me.code);
  wrap.innerHTML = (db.rewards.length ? db.rewards : [])
    .map((r) => {
      const bought = mine.filter((x) => x.rewardId === r.id).length;
      const can = pts >= r.cost;
      return '<div class="reward-card">' +
        '<span class="reward-emoji">' + esc(r.emoji || "🎁") + '</span>' +
        '<div class="reward-name">' + esc(r.name) + '</div>' +
        '<span class="reward-cost' + (can ? " affordable" : "") + '">' + r.cost + ' ⭐</span>' +
        '<div>' + (bought
          ? '<span class="owned-chip">✓ مطلوبة (' + bought + ')</span>'
          : '<button class="btn gold" data-redeem="' + esc(r.id) + '"' + (can ? "" : " disabled") + '>استبدال</button>') + '</div>' +
        '</div>';
    }).join("") || '<div class="muted">لسه مفيش مكافآت — المستر هيضيف قريب.</div>';

  wrap.querySelectorAll("[data-redeem]").forEach((b) => {
    b.addEventListener("click", async () => {
      const r = db.rewards.find((x) => x.id === b.dataset.redeem);
      if (!r) return;
      const myPts = pointsOf(me.code);
      if (myPts < r.cost) { toast("نقطك مش كفاية — كمّل اجمع! 💪"); return; }
      awardPoints(me.code, me.name, -r.cost, "استبدال مكافأة: " + r.name);
      db.redemptions.push({ id: uid("rd"), rewardId: r.id, rewardName: r.name, code: me.code, name: me.name, at: Date.now() });
      await saveDB(["points", "redemptions"]);
      renderHeaderPoints(); renderPointsBar(); renderLeaderboard();
      toast("🎁 اتبعت طلبك لمستر عادل — استلم مكافأتك في الحصة!");
    });
  });
}

/* ============================================================
   بنك المناهج المصرية — المنهج الجديد 2026/2027 من كتاب الوزارة
   مصدر الوحدات: فهارس كتب الوزارة المعتمدة + كتب المكتبة الرسمية
   (كل ترم فيه 6 وحدات بالظبط زي الكتاب الرسمي)
   ============================================================ */
const CURRICULUM = {
  "1 Prim": { book: "English Primary 1 (منهج 2026)", terms: [
    { label: "الترم الأول", units: ["Unit 1: Welcome to My School", "Unit 2: The Garden of Colors and Shapes", "Unit 3: I Love My Family", "Unit 4: My Body and My Senses", "Unit 5: On the Farm", "Unit 6: Animals Around Me"] },
    { label: "الترم الثاني", units: ["Unit 1: My Week", "Unit 2: Feelings", "Unit 3: Seasons", "Unit 4: My House", "Unit 5: Neighborhood", "Unit 6: Story: Two Friends and One Apple"] }
  ] },
  "2 Prim": { book: "English Primary 2 (منهج 2026)", terms: [
    { label: "الترم الأول", units: ["Unit 1: Let's Get Started", "Unit 2: Colors, Shapes, and Numbers", "Unit 3: Classroom Actions & Routines", "Unit 4: Everyday Life", "Unit 5: My Home", "Unit 6: Rooms at Home"] },
    { label: "الترم الثاني", units: ["Unit 1: Our Environment", "Unit 2: At the Store", "Unit 3: Sports", "Unit 4: Transportation", "Unit 5: The Pyramids", "Unit 6: A Day with My Family"] }
  ] },
  "3 Prim": { book: "English Primary 3 (منهج 2026)", terms: [
    { label: "الترم الأول", units: ["Unit 1: Let's Learn Together!", "Unit 2: My Family and I", "Unit 3: New Adventures", "Unit 4: Let's Tell Stories!", "Unit 5: Together Is Better", "Unit 6: Dare to Dream"] },
    { label: "الترم الثاني", units: ["Unit 1: Safety", "Unit 2: Food and Health", "Unit 3: Heroes Around Us", "Unit 4: Living with Technology", "Unit 5: Animals and Habitats", "Unit 6: The Honest Choice"] }
  ] },
  "4 Prim": { book: "English Primary 4 (منهج 2026)", terms: [
    { label: "الترم الأول", units: ["Unit 1: The Five Senses", "Unit 2: My Community", "Unit 3: Animals In Our World", "Unit 4: Egypt My Homeland", "Unit 5: A Day At Work", "Unit 6: The Hundred Dresses"] },
    { label: "الترم الثاني", units: ["Unit 1: This is Where I Live", "Unit 2: Our World, Our Responsibility", "Unit 3: What's in the Package?", "Unit 4: Let's Celebrate", "Unit 5: Exploring Wonders in Egypt", "Unit 6: The Lost Kite"] }
  ] },
  "5 Prim": { book: "English Primary 5 (منهج 2026)", terms: [
    { label: "الترم الأول", units: ["Unit 1: Food, Nature, and Culture", "Unit 2: My Healthy Body", "Unit 3: When Nature Changes", "Unit 4: My Community", "Unit 5: Our World, Our Resources", "Unit 6: The Talking Earth"] },
    { label: "الترم الثاني", units: ["Unit 1: Hobbies Make Us Shine!", "Unit 2: At the Doctor's", "Unit 3: Suitcase Stories", "Unit 4: Jobs in The Animal Kingdom", "Unit 5: Our Solar System", "Unit 6: Offline but Happy"] }
  ] },
  "6 Prim": { book: "English Primary 6 (منهج 2026)", terms: [
    { label: "الترم الأول", units: ["Unit 1: Amazing Places in Egypt", "Unit 2: Our Nature", "Unit 3: Community Builders", "Unit 4: Resources Around Us", "Unit 5: Made in Egypt", "Unit 6: The Water Savers"] },
    { label: "الترم الثاني", units: ["Unit 1: Celebrating Creativity", "Unit 2: Wonderful Inventions", "Unit 3: Hidden Gems of Egypt", "Unit 4: Egypt on The Move", "Unit 5: Safe and Smart Transportation", "Unit 6: Story Time: The Library That Time Forgot"] }
  ] },
  "1 Prep": { book: "Hello! Beyond Words 1", terms: [
    { label: "الترم الأول", units: ["Unit 1: A Great Summer", "Unit 2: My Network", "Unit 3: My Time", "Unit 4: Digital Life", "Unit 5: In Nature", "Unit 6: Food for Thought"] },
    { label: "الترم الثاني", units: ["Unit 7: Helping Each Other to Learn", "Unit 8: New Life in Old Cities", "Unit 9: Plans with Friends", "Unit 10: The Online Generation", "Unit 11: Clean Transportation", "Unit 12: Sustainable Tourism"] }
  ] },
  "2 Prep": { book: "Hello! Beyond Words 2", terms: [
    { label: "الترم الأول", units: ["Unit 1: Gen Alpha", "Unit 2: My Digital Footprint", "Unit 3: Facing Challenges", "Unit 4: Art and Expression", "Unit 5: Around the World", "Unit 6: Young Innovators"] },
    { label: "الترم الثاني", units: ["Unit 7: My School Life", "Unit 8: Learn Smart, Learn Easy", "Unit 9: Jobs & Skills", "Unit 10: Storytelling", "Unit 11: Life in the Desert", "Unit 12: Our Incredible Earth"] }
  ] },
  "3 Prep": { book: "Hello! Beyond Words 3", terms: [
    { label: "الترم الأول", units: ["Unit 1: Personal Identity", "Unit 2: Communication with Family and Friends", "Unit 3: Artificial Intelligence", "Unit 4: Screen Time", "Unit 5: Design Thinking", "Unit 6: Why Do We Like Stories?"] },
    { label: "الترم الثاني", units: ["Unit 7: Sports", "Unit 8: Cultures and Traditions", "Unit 9: Courage and Survival", "Unit 10: Animal Adaptations", "Unit 11: Stories on the Move", "Unit 12: Leadership and Teamwork"] }
  ] }
};
const GRADE_LABELS = { "1 Prim": "الأول الابتدائي", "2 Prim": "الثاني الابتدائي", "3 Prim": "الثالث الابتدائي", "4 Prim": "الرابع الابتدائي", "5 Prim": "الخامس الابتدائي", "6 Prim": "السادس الابتدائي", "1 Prep": "الأول الإعدادي", "2 Prep": "الثاني الإعدادي", "3 Prep": "الثالث الإعدادي" };
function currentTermIndex() {
  const m = new Date().getMonth() + 1; // 1-12
  return (m >= 9 || m <= 1) ? 0 : 1;
}
const FALLBACK_QUESTIONS = {
  grammar: [
    { q: "Choose the correct form: She ___ to school every day.", choices: ["go", "goes", "going", "gone"], correct: 1 },
    { q: "I ___ my homework yesterday.", choices: ["do", "does", "did", "doing"], correct: 2 },
    { q: "They ___ watching TV now.", choices: ["is", "am", "are", "be"], correct: 2 },
    { q: "We have lived here ___ 2015.", choices: ["for", "since", "ago", "during"], correct: 1 },
    { q: "He is ___ than his brother.", choices: ["tall", "taller", "tallest", "more tall"], correct: 1 },
    { q: "There ___ some milk in the fridge.", choices: ["is", "are", "were", "be"], correct: 0 },
    { q: "I'm looking forward to ___ you.", choices: ["see", "saw", "seeing", "sees"], correct: 2 },
    { q: "If it rains, we ___ stay at home.", choices: ["will", "would", "did", "are"], correct: 0 }
  ],
  vocabulary: [
    { q: "What is the opposite of 'easy'?", choices: ["simple", "difficult", "happy", "fast"], correct: 1 },
    { q: "A place where you buy medicine:", choices: ["bakery", "library", "pharmacy", "stadium"], correct: 2 },
    { q: "The past of 'buy' is:", choices: ["buyed", "bought", "buys", "buying"], correct: 1 },
    { q: "Which word is a fruit?", choices: ["carrot", "potato", "banana", "onion"], correct: 2 },
    { q: 'The synonym of "happy" is:', choices: ["sad", "glad", "angry", "tired"], correct: 1 },
    { q: "Doctors work in a ___.", choices: ["hospital", "school", "farm", "factory"], correct: 0 }
  ]
};

/* ============================================================
   الذكاء الاصطناعي (Gemini) — مولد كويز + مساعد + اختبار المفتاح
   ============================================================ */
function aiAvailable() {
  return !!(db.settings && db.settings.aiKey && String(db.settings.aiKey).trim().startsWith("AIza"));
}
const AI_MODELS = {
  "gemini-2.5-flash": "Gemini 2.5 Flash — سريع واقتصادي",
  "gemini-2.5-pro": "Gemini 2.5 Pro — أقوى (أبطأ وأغلى)",
  "gemini-2.0-flash": "Gemini 2.0 Flash — قديم لكن مستقر"
};
function geminiErrorHint(status, raw) {
  const t = (raw || "").slice(0, 300);
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(t)) return "المفتاح مش صحيح — جيب مفتاح جديد من aistudio.google.com/apikey";
  if (status === 400 && /User location is not supported/i.test(t)) return "جوجل مش مدعم في بلد السيرفر — جرب من شبكة تانية";
  if (status === 403) return "المفتاح ممنوع من الوصول للنموذج ده — اتأكد إن Generative Language API مفعّلة في Google Cloud";
  if (status === 404) return "اسم النموذج مش موجود — جرب نموذج تاني من القائمة";
  if (status === 429) return "تجاوزت الحد المسموح من الطلبات — استنى شوية وجرب تاني";
  if (status >= 500) return "مشكلة من سيرفرات جوجل — جرب تاني بعد شوية";
  return "خطأ من الخدمة (" + status + "): " + t;
}
async function geminiText(systemPrompt, userPrompt, jsonMode) {
  const model = (db.settings && db.settings.aiModel) || "gemini-2.5-flash";
  const key = String(db.settings.aiKey).trim();
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: jsonMode
      ? { responseMimeType: "application/json", temperature: 1.0 }
      : { temperature: 0.7 }
  };
  let res;
  try {
    res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key),
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
  } catch (netErr) {
    throw new Error("مشكلة إنترنت — المنصة مش قادرة توصل لسيرفرات جوجل. اتأكد من الاتصال.");
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(geminiErrorHint(res.status, errText));
  }
  const data = await res.json();
  const cand = data && data.candidates && data.candidates[0];
  const text = cand && cand.content && cand.content.parts && cand.content.parts.map((p) => p.text || "").join("");
  if (!text) {
    if (cand && cand.finishReason === "SAFETY") throw new Error("الرد اتحجب بفلتر المحتوى — جرب صياغة تانية");
    throw new Error("رد فارغ من الذكاء الاصطناعي");
  }
  return text;
}

async function aiTestKey() {
  // اختبار حقيقي: ابعث طلب بسيط وشوف الرد
  if (!aiAvailable()) return { ok: false, msg: "مفيش مفتاح — الصق المفتاح الأول (يبدأ بـ AIza)" };
  const oldModel = db.settings.aiModel;
  const models = [oldModel || "gemini-2.5-flash", "gemini-2.5-flash", "gemini-2.0-flash"].filter((m, i, a) => a.indexOf(m) === i);
  let lastErr = null;
  for (const m of models) {
    try {
      db.settings.aiModel = m;
      const reply = await geminiText("Reply with exactly: OK", "ping", false);
      if (reply) {
        db.settings.aiModel = m; // النموذج الشغال
        return { ok: true, msg: "الاتصال ناجح ✓ — النموذج " + m + " شغال", model: m };
      }
    } catch (e) {
      lastErr = e;
    }
  }
  db.settings.aiModel = oldModel;
  return { ok: false, msg: lastErr ? lastErr.message : "فشل الاتصال بكل النماذج" };
}

async function aiGenerateQuizQuestions(grade, termIdx, unit, count) {
  const c = CURRICULUM[grade];
  const book = c ? c.book : "English";
  const termLabel = c && c.terms[termIdx] ? c.terms[termIdx].label : "";
  const sys = "You are an expert Egyptian English curriculum item writer for the Egyptian Ministry of Education textbooks (" + book + ", " + termLabel + "). You write multiple-choice questions exactly matching the vocabulary, grammar and topics of the requested unit, appropriate for the students' age. Output ONLY valid JSON.";
  const user = 'Create ' + count + ' multiple-choice English questions for Egyptian grade "' + (GRADE_LABELS[grade] || grade) + '" from the textbook "' + book + '", ' + termLabel + ', unit "' + unit + '".\n' +
    'Rules:\n- 4 answer options each, exactly one correct.\n- Mix: vocabulary, grammar, and one dialogue completion if suitable.\n- Simple, clear wording suitable for Egyptian primary/prep students.\n- Distractors must be plausible but definitely wrong.\n' +
    'Return JSON: {"questions":[{"q":"question text","choices":["a","b","c","d"],"correct":0}]} (correct = index 0-3)';
  const raw = await geminiText(sys, user, true);
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "");
  const parsed = JSON.parse(cleaned);
  const qs = (parsed.questions || parsed || []).filter((x) => x && x.q && Array.isArray(x.choices) && x.choices.length >= 2 && typeof x.correct === "number");
  if (!qs.length) throw new Error("صيغة الأسئلة الراجعة من الـ AI مش صحيحة");
  return qs.slice(0, count).map((x) => ({ q: String(x.q), choices: x.choices.map(String).slice(0, 4), correct: Math.min(3, Math.max(0, x.correct)) }));
}

function fallbackQuizQuestions(count) {
  const pool = [...FALLBACK_QUESTIONS.grammar, ...FALLBACK_QUESTIONS.vocabulary];
  const shuffled = pool.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, pool.length));
}

let aiMessages = [];
const AI_SUGGESTIONS = [
  "إيه الفرق بين since و for؟",
  "اشرحلي Present Perfect ببساطة",
  "إيه معنى كلمة environment؟",
  "صحّحلي: He go to school"
];
function initAI() {
  const status = $("aiStatus");
  if (!status) return;
  if (aiAvailable()) {
    status.textContent = "متصل بـ Gemini ✓ (" + (db.settings.aiModel || "gemini-2.5-flash") + ")";
    status.className = "chip green";
  } else {
    status.textContent = "وضع مبسط (بدون مفتاح AI)";
    status.className = "chip gray";
  }
  if (!$("aiMessages").dataset.seeded) {
    $("aiMessages").dataset.seeded = "1";
    aiMessages.push({ role: "bot", text: "أهلاً يا " + (me ? me.name.split(" ")[0] : "صديقي") + "! 👋 أنا مساعدك الذكي في الإنجليزي. اسألني أي حاجة في القواعد أو المفردات أو الترجمة، وهشرحها ليك ببساطة." });
    renderAIMessages();
    renderAISuggestions();
  }
}
function renderAISuggestions() {
  const box = $("aiSuggestions");
  if (!box) return;
  box.innerHTML = AI_SUGGESTIONS.map((s) => '<button type="button" data-sug="' + esc(s) + '">' + esc(s) + '</button>').join("");
  box.querySelectorAll("[data-sug]").forEach((b) => {
    b.addEventListener("click", () => { $("aiInput").value = b.dataset.sug; sendAIMessage(); });
  });
}
function renderAIMessages() {
  const box = $("aiMessages");
  if (!box) return;
  box.innerHTML = aiMessages.map((m) =>
    '<div class="ai-msg ' + (m.role === "user" ? "user" : "bot") + '">' +
    (m.role === "bot" ? '<span class="ai-label">🤖 مساعد مستر عادل</span>' : "") +
    esc(m.text) + '</div>'
  ).join("");
  box.scrollTop = box.scrollHeight;
}
function aiFallbackReply(q) {
  const lower = q.toLowerCase();
  if (lower.includes("since") && lower.includes("for")) {
    return "الفرق ببساطة:\n• since + نقطة زمنية محددة (since 2015, since Monday)\n• for + مدة زمنية (for 3 years, for two hours)\nمثال: I have lived here since 2020. / I have lived here for 6 years.";
  }
  if (lower.includes("present perfect")) {
    return "Present Perfect ببساطة:\n• التكوين: have/has + التصريف التالت\n• بيحصل في الماضي بس مفعوله لسه موجود دلوقتي\n• كلمات دالة: just, already, yet, ever, never, since, for\nمثال: I have finished my homework. (خلصته وخلاص، مفعوله موجود)";
  }
  if (lower.includes("معنى") || lower.includes("ايه معنى")) {
    return "أنا في الوضع المبسط مش بقدر أترجم أي كلمة، بس مستر عادل يقدر يفعّل الذكاء الاصطناعي الكامل بوضع مفتاح Gemini في لوحة التحكم، وساعتها هرد على أي كلمة فوراً! 🚀";
  }
  return "سؤال جميل! 👌 أنا دلوقتي في الوضع المبسط، فإجابتي محدودة. اطلب من مستر عادل يضيف مفتاح الذكاء الاصطناعي من لوحة التحكم وهجاوبك على أي حاجة بالتفصيل، وبين الوقت اكتب سؤالك في المنتدى وهيرد عليك المستر أو زمايلك.";
}
async function sendAIMessage() {
  const input = $("aiInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  aiMessages.push({ role: "user", text });
  renderAIMessages();

  const typing = document.createElement("div");
  typing.className = "ai-msg bot ai-typing";
  typing.innerHTML = "<span></span><span></span><span></span>";
  $("aiMessages").appendChild(typing);
  $("aiMessages").scrollTop = $("aiMessages").scrollHeight;

  let reply = "";
  if (aiAvailable()) {
    try {
      const sys = "أنت مساعد تعليمي ودود لطلاب مصر في المرحلة الابتدائية والإعدادية لمادة اللغة الإنجليزية (منهج وزارة التربية والتعليم المصري الجديد 2026: كتب English Primary للابتدائي وHello! Beyond Words للإعدادي). أجب بالعربية المصرية البسيطة مع أمثلة إنجليزية واضحة، بأسلوب محفز وقصير (3-8 أسطر). لو الطالب كتب جملة إنجليزية فيها خطأ، صححها واشرح الخطأ ببساطة. ممنوع أي محتوى غير تعليمي.";
      reply = await geminiText(sys, text, false);
    } catch (e) {
      reply = "⚠ " + (e && e.message ? e.message : "حصلت مشكلة في الاتصال بالذكاء الاصطناعي") + "\nجرب تاني، ولو استمرت المشكلة كلم مستر عادل يضغط «اختبار المفتاح» في الإعدادات.";
    }
  } else {
    await new Promise((r) => setTimeout(r, 500));
    reply = aiFallbackReply(text);
  }
  typing.remove();
  aiMessages.push({ role: "bot", text: reply });
  renderAIMessages();
}

/* ============================================================
   لوحة المستر
   ============================================================ */
function teacherLogin() {
  const pass = $("teacherPass").value;
  const err = $("teacherError");
  err.style.display = "none";
  if (pass === db.settings.teacherPass) {
    teacherUnlocked = true;
    $("teacherGate").classList.add("hidden");
    $("teacherContainer").classList.remove("hidden");
    renderTeacher();
  } else {
    err.textContent = "كلمة السر غير صحيحة.";
    err.style.display = "block";
  }
}
function teacherExit() {
  if (me) { openStudent(); }
  else { show("loginView"); }
}

function sectionCard(title, inner) {
  return '<div class="teacher-section"><h3>' + title + '</h3>' + inner + '</div>';
}

function renderTeacherAdminExtras() {
  const rw = $("adminRewardsList");
  if (rw) {
    rw.innerHTML = db.rewards.length
      ? db.rewards.map((r) =>
        '<div class="list-item"><span>' + esc(r.emoji || "🎁") + " <b>" + esc(r.name) + '</b> — ' + r.cost + ' ⭐</span>' +
        '<span class="actions"><button class="btn tiny danger" data-del-reward="' + esc(r.id) + '">حذف</button></span></div>'
      ).join("") : '<div class="muted">مفيش مكافآت.</div>';
    rw.querySelectorAll("[data-del-reward]").forEach((b) => {
      b.addEventListener("click", async () => {
        if (!confirm("حذف المكافأة؟")) return;
        db.rewards = db.rewards.filter((r) => r.id !== b.dataset.delReward);
        await cloudDelete("rewards", b.dataset.delReward);
        touchLocal();
        renderTeacher();
      });
    });
  }
  const rd = $("redemptionList");
  if (rd) {
    const pending = db.redemptions.slice().reverse();
    rd.innerHTML = pending.length
      ? pending.map((r) =>
        '<div class="list-item"><span>' + (r.status ? "✅" : "<span class='pending-dot'></span>") + " <b>" + esc(r.name) + '</b> طلب «' + esc(r.rewardName) + '» — ' + r.cost + ' نقطة' + (r.status ? ' <span class="chip green">' + esc(r.status) + '</span>' : '') + '</span>' +
        '<span class="actions">' + (r.status ? "" :
          '<button class="btn tiny primary" data-approve-redeem="' + esc(r.id) + '">تم التسليم</button>' +
          '<button class="btn tiny danger" data-reject-redeem="' + esc(r.id) + '">رفض وإرجاع</button>') + '</span></div>'
      ).join("") : '<div class="muted">مفيش طلبات لسه.</div>';
    rd.querySelectorAll("[data-approve-redeem]").forEach((b) => {
      b.addEventListener("click", async () => {
        const r = db.redemptions.find((x) => x.id === b.dataset.approveRedeem);
        if (r) { r.status = "تم التسليم"; await saveDB(["redemptions"]); renderTeacher(); toast("✓ اتعلمت كمُسلّمة"); }
      });
    });
    rd.querySelectorAll("[data-reject-redeem]").forEach((b) => {
      b.addEventListener("click", async () => {
        if (!confirm("رفض الطلب ورجّع النقط للطالب؟")) return;
        const r = db.redemptions.find((x) => x.id === b.dataset.rejectRedeem);
        if (r) {
          awardPoints(r.code, r.name, r.cost, "إرجاع نقط مكافأة مرفوضة: " + r.rewardName);
          r.status = "مرفوض — اترجعت النقط";
          await saveDB(["redemptions", "points"]);
          renderTeacher();
          toast("✓ اترجعت النقط للطالب");
        }
      });
    });
  }
}

function renderTeacher() {
  $("teacherDbMode").textContent = cloudAvailable ? "متصل بالسحابة ✓" : "وضع محلي";
  const c = $("teacherContainer");
  c.innerHTML =
    '<div class="notice gold">📌 الأكواد دي هي اللي يتوزع على الطلاب — كل طالب بيكتب كوده في صفحة الدخول.</div>' +
    sectionCard("إحصائيات سريعة", teacherStatsHTML()) +
    sectionCard("الطلاب والأكواد", teacherStudentsHTML()) +
    sectionCard("⭐ النقط والمكافآت", teacherPointsHTML()) +
    sectionCard("📨 طلبات استبدال المكافآت", '<div id="redemptionList"></div>') +
    sectionCard("الحضور", teacherAttendanceHTML()) +
    sectionCard("الامتحانات والكويزات", teacherQuizzesHTML()) +
    sectionCard("النتائج", teacherResultsHTML()) +
    sectionCard("الشروحات", teacherLessonsHTML()) +
    sectionCard("المنتدى", teacherForumHTML()) +
    sectionCard("الإعدادات", teacherSettingsHTML()) +
    sectionCard("نسخة احتياطية",
      '<button class="btn primary" id="exportBtn">⬇ تنزيل نسخة JSON</button> ' +
      '<button class="btn ghost" id="importBtnTrigger">⬆ استيراد نسخة</button>' +
      '<input type="file" id="importFileInput" accept="application/json" class="hidden">'
    ) +
    '<div style="height:40px;"></div>';

  bindTeacherEvents();
  renderTeacherAdminExtras();
}

function teacherStatsHTML() {
  const avgAll = db.submissions.length
    ? Math.round(db.submissions.reduce((s, x) => s + (x.score / Math.max(1, x.max)) * 100, 0) / db.submissions.length)
    : 0;
  const grid = [
    { n: db.students.length, l: "طالب" },
    { n: db.lessons.length, l: "درس" },
    { n: db.quizzes.length, l: "امتحان" },
    { n: db.submissions.length, l: "تسليم" },
    { n: avgAll + "%", l: "متوسط عام" },
    { n: db.forum.length, l: "موضوع بالمنتدى" }
  ];
  return '<div class="stats-grid">' + grid.map((g) =>
    '<div class="stat-card"><b>' + esc(String(g.n)) + '</b><span>' + esc(g.l) + '</span></div>').join("") + '</div>';
}

function teacherStudentsHTML() {
  return '<div class="grid-2">' +
    '<div class="field"><label>اسم الطالب</label><input id="nsName" placeholder="مثال: أحمد محمد"></div>' +
    '<div class="field"><label>الفصل</label><input id="nsGrade" placeholder="مثال: 3A"></div>' +
    '</div>' +
    '<div class="field"><label>رقم واتساب ولي الأمر (اختياري — عشان يوصلك كود الطالب)</label><input id="nsPhone" placeholder="01xxxxxxxxx"></div>' +
    '<button class="btn primary" id="addStudentBtn">+ إضافة طالب وتوليد كود</button>' +
    '<div class="notice">اضغط على الكود لنسخه، وزر الواتساب لتبعت الكود لولي الأمر.</div>' +
    '<div id="studentsList">' + db.students.map((s) => {
      const digits = String(s.phone || "").replace(/\D/g, "");
      const wa = digits ? (digits.startsWith("20") ? digits : digits.startsWith("0") ? "2" + digits : "20" + digits) : "";
      return '<div class="list-item"><span><b>' + esc(s.name) + '</b> — ' + esc(s.grade) +
        ' <span class="code-pill" data-copy="' + esc(s.code) + '" style="cursor:pointer;">' + esc(s.code) + '</span></span>' +
        '<span class="actions">' +
        (wa ? '<a class="btn tiny ghost" target="_blank" href="https://wa.me/' + wa + '?text=' + encodeURIComponent("مرحباً، كود دخول الطالب " + s.name + " لمنصة مستر عادل عزت: " + s.code) + '">📱 واتساب</a>' : '') +
        '<button class="btn tiny danger" data-del-student="' + esc(s.id || s.code) + '">حذف</button></span></div>';
    }).join("") + '</div>';
}

function teacherAttendanceHTML() {
  const dates = [...new Set(db.attendance.map((a) => a.date))].sort().reverse();
  return '<div class="grid-3">' +
    '<div class="field"><label>تاريخ الحصة</label><input type="date" id="attDate" value="' + todayStr() + '"></div>' +
    '<div class="field"><label>فصل معين (اختياري)</label><input id="attGrade" placeholder="مثال: 3A — فاضي لكل الفصول"></div>' +
    '<div class="field"><label>&nbsp;</label><button class="btn primary block" id="openAttBtn">فتح كشف الحضور</button></div>' +
    '</div>' +
    (dates.length ? '<h4 style="margin:10px 0 6px;">كشوف سابقة</h4>' + dates.map((d) => {
      const recs = db.attendance.filter((a) => a.date === d);
      const p = recs.filter((r) => r.present).length;
      return '<div class="list-item"><span>' + esc(prettyDate(d)) + ' — حاضر ' + p + ' من ' + recs.length + '</span>' +
        '<span class="actions"><button class="btn tiny ghost" data-view-att="' + esc(d) + '">عرض/تعديل</button></span></div>';
    }).join("") : '<div class="muted">لسه مفيش كشوف حضور.</div>') +
    '<div id="attSheet"></div>';
}

function openAttendanceSheet(date, gradeFilter) {
  const students = db.students.filter((s) => !gradeFilter || s.grade === gradeFilter);
  if (!students.length) { toast("مفيش طلاب مطابقين."); return; }
  const sheet = $("attSheet");
  sheet.innerHTML = '<h4 style="margin:12px 0 6px;">كشف ' + esc(prettyDate(date)) + '</h4>' +
    students.map((s) => {
      const rec = db.attendance.find((a) => a.date === date && a.code === s.code);
      const isPresent = rec ? rec.present : null;
      return '<div class="list-item"><span><b>' + esc(s.name) + '</b> — ' + esc(s.grade) + ' (' + esc(s.code) + ')</span>' +
        '<span class="actions">' +
        '<button class="btn tiny ' + (isPresent === true ? "primary" : "ghost") + '" data-att="1" data-code="' + esc(s.code) + '">حاضر</button>' +
        '<button class="btn tiny ' + (isPresent === false ? "danger" : "ghost") + '" data-att="0" data-code="' + esc(s.code) + '">غائب</button>' +
        '</span></div>';
    }).join("");
  sheet.querySelectorAll("[data-att]").forEach((b) => {
    b.addEventListener("click", async () => {
      const code = b.dataset.code;
      const present = b.dataset.att === "1";
      const rec = db.attendance.find((a) => a.date === date && a.code === code);
      if (rec) {
        rec.present = present;
      } else {
        db.attendance.push({ id: uid("att"), date, code, present });
        if (present) {
          const st = db.students.find((s) => s.code === code);
          awardPoints(code, st ? st.name : "", 3, "حضور يوم " + date);
        }
      }
      await saveDB(["attendance", "points"]);
      openAttendanceSheet(date, gradeFilter);
    });
  });
}

function teacherQuizzesHTML() {
  return '<div class="field"><label>عنوان الامتحان/الكويز</label><input id="nqTitle" placeholder="مثال: كويز Unit 2"></div>' +
    '<div class="field"><label>وصف مختصر (اختياري)</label><input id="nqDesc" placeholder="المدة، المنهج..."></div>' +
    '<button class="btn primary" id="createQuizBtn">+ إنشاء امتحان جديد</button>' +
    '<div style="margin-top:10px;">' + (db.quizzes.length ? db.quizzes.slice().reverse().map((q) =>
      '<div class="list-item"><span><b>' + esc(q.title) + '</b> — ' + q.questions.length + ' سؤال — ' + esc(q.date || "") + '</span>' +
      '<span class="actions">' +
      '<button class="btn tiny ghost" data-edit-quiz="' + esc(q.id) + '">تعديل الأسئلة</button>' +
      '<button class="btn tiny danger" data-del-quiz="' + esc(q.id) + '">حذف</button></span></div>'
    ).join("") : '<div class="muted">مفيش امتحانات.</div>') + '</div>' +
    '<div id="quizEditor"></div>' +
    '<h4 class="ai-quiz-heading">✨ إنشاء كويز بالذكاء الاصطناعي (منهج الوزارة 2026)</h4>' +
    '<div class="ai-quiz-box">' +
    '<div class="grid-3">' +
    '<div class="field"><label>الصف</label><select id="aiGrade">' +
      Object.keys(CURRICULUM).map((g) => '<option value="' + g + '">' + (GRADE_LABELS[g] || g) + ' — ' + CURRICULUM[g].book + '</option>').join("") +
    '</select></div>' +
    '<div class="field"><label>الترم</label><select id="aiTerm"></select></div>' +
    '<div class="field"><label>الوحدة (من كتاب الوزارة)</label><select id="aiUnit"></select></div>' +
    '</div>' +
    '<div class="grid-2">' +
    '<div class="field"><label>عدد الأسئلة</label><select id="aiCount"><option>5</option><option selected>8</option><option>10</option></select></div>' +
    '<div class="field"><label>المصدر</label><select id="aiMode"><option value="ai">🤖 ذكاء اصطناعي (يحتاج مفتاح Gemini)</option><option value="fallback">📦 بنك أسئلة جاهز (بدون مفتاح)</option></select></div>' +
    '</div>' +
    '<button class="btn gold block" id="aiGenerateBtn">✨ توليد الكويز</button>' +
    '<div id="aiGenStatus" class="muted" style="margin-top:8px;"></div>' +
    '</div>';
}

function fillUnitSelect() {
  const gradeSel = $("aiGrade");
  const termSel = $("aiTerm");
  const unitSel = $("aiUnit");
  if (!gradeSel || !unitSel) return;
  const c = CURRICULUM[gradeSel.value];
  if (!c) return;
  if (termSel) {
    const cur = currentTermIndex();
    termSel.innerHTML = c.terms.map((t, i) =>
      '<option value="' + i + '"' + (i === cur ? " selected" : "") + '>' + esc(t.label) + '</option>'
    ).join("");
    if (!termSel.dataset.bound) {
      termSel.dataset.bound = "1";
      termSel.addEventListener("change", fillUnitSelect);
    }
  }
  const ti = termSel ? Number(termSel.value || 0) : currentTermIndex();
  const term = c.terms[ti] || c.terms[0];
  unitSel.innerHTML = term.units.map((u) => '<option>' + esc(u) + '</option>').join("");
}

async function runQuizGeneration() {
  const btn = $("aiGenerateBtn");
  const status = $("aiGenStatus");
  const grade = $("aiGrade").value;
  const termIdx = $("aiTerm") ? Number($("aiTerm").value || 0) : currentTermIndex();
  const unit = $("aiUnit").value;
  const count = Number($("aiCount").value);
  const mode = $("aiMode").value;
  const useAI = mode === "ai" && aiAvailable();
  if (mode === "ai" && !aiAvailable()) {
    status.innerHTML = '<span class="gen-status-err">محتاج مفتاح Gemini — ضيفه من الإعدادات، أو اختار «بنك أسئلة جاهز».</span>';
    return;
  }
  btn.disabled = true;
  status.innerHTML = '⏳ جاري توليد الأسئلة' + (useAI ? ' بالذكاء الاصطناعي' : '') + '<span class="spinner-mini"></span>';
  try {
    let questions;
    if (useAI) {
      questions = await aiGenerateQuizQuestions(grade, termIdx, unit, count);
    } else {
      await new Promise((r) => setTimeout(r, 400));
      questions = fallbackQuizQuestions(count);
    }
    const c = CURRICULUM[grade];
    const termLabel = c && c.terms[termIdx] ? c.terms[termIdx].label : "";
    const quiz = {
      id: uid("qz"),
      title: (useAI ? "🤖 " : "📦 ") + unit + " — " + (c ? c.book : grade),
      desc: "كويز " + (useAI ? "مولّد بالذكاء الاصطناعي" : "من البنك الجاهز") + " • " + unit + " • " + (c ? c.book : "") + " • " + termLabel,
      date: todayStr(),
      questions,
      generatedBy: useAI ? "ai" : "bank",
      gradeTag: grade,
      termIdx
    };
    db.quizzes.push(quiz);
    await saveDB(["quizzes"]);
    status.innerHTML = '<span class="gen-status-ok">✓ اتولد كويز «' + esc(quiz.title) + '" بـ ' + questions.length + ' سؤال — موجود دلوقتي عند الطلاب!</span>';
    renderTeacher();
  } catch (e) {
    status.innerHTML = '<span class="gen-status-err">✗ ' + esc(e.message || "خطأ غير متوقع") + '</span>';
  }
  btn.disabled = false;
}

let editQuizId = null;
function openQuizEditor(qid) {
  editQuizId = qid;
  const q = db.quizzes.find((x) => x.id === qid);
  if (!q) return;
  const ed = $("quizEditor");
  ed.innerHTML = '<h4 style="margin:14px 0 8px;">تعديل: ' + esc(q.title) + '</h4>' +
    q.questions.map((qq, qi) =>
      '<div class="teacher-section" style="padding:12px;margin-bottom:10px;">' +
      '<div class="field"><label>السؤال ' + (qi + 1) + '</label><input data-qtext="' + qi + '" value="' + esc(qq.q) + '"></div>' +
      '<div class="grid-2">' +
      qq.choices.map((c, ci) => '<div class="field"><label>اختيار ' + (ci + 1) + (qq.correct === ci ? " (الصح)" : "") + '</label>' +
        '<input data-qchoice="' + qi + ':' + ci + '" value="' + esc(c) + '"></div>').join("") +
      '</div>' +
      '<div class="field"><label>رقم الإجابة الصحيحة (1-4)</label><input type="number" min="1" max="4" data-qcorrect="' + qi + '" value="' + (qq.correct + 1) + '"></div>' +
      '<button class="btn tiny danger" data-del-q="' + qi + '">حذف السؤال</button>' +
      '</div>'
    ).join("") +
    '<button class="btn ghost" id="addQBtn">+ إضافة سؤال</button> ' +
    '<button class="btn primary" id="saveQuizBtn">💾 حفظ التعديلات</button>';
  ed.querySelectorAll("[data-del-q]").forEach((b) => b.addEventListener("click", () => {
    q.questions.splice(Number(b.dataset.delQ), 1);
    openQuizEditor(qid);
  }));
  $("addQBtn").addEventListener("click", () => {
    q.questions.push({ q: "سؤال جديد؟", choices: ["", "", "", ""], correct: 0 });
    openQuizEditor(qid);
  });
  $("saveQuizBtn").addEventListener("click", async () => {
    ed.querySelectorAll("[data-qtext]").forEach((inp) => {
      q.questions[Number(inp.dataset.qtext)].q = inp.value.trim();
    });
    ed.querySelectorAll("[data-qchoice]").forEach((inp) => {
      const [qi, ci] = inp.dataset.qchoice.split(":").map(Number);
      q.questions[qi].choices[ci] = inp.value.trim();
    });
    ed.querySelectorAll("[data-qcorrect]").forEach((inp) => {
      q.questions[Number(inp.dataset.qcorrect)].correct = Math.max(0, Math.min(3, Number(inp.value) - 1));
    });
    await saveDB(["quizzes"]);
    toast("✓ تم حفظ الامتحان");
    renderTeacher();
  });
}

function teacherResultsHTML() {
  if (!db.submissions.length) return '<div class="muted">لسه مفيش نتائج.</div>';
  return '<div class="table-wrap"><table><tr><th>الطالب</th><th>الفصل</th><th>الامتحان</th><th>الدرجة</th><th>التاريخ</th></tr>' +
    db.submissions.slice().reverse().map((s) => {
      const q = db.quizzes.find((x) => x.id === s.quizId);
      return '<tr><td>' + esc(s.name) + '</td><td>' + esc(s.grade) + '</td><td>' + esc(q ? q.title : "—") + '</td>' +
        '<td><b>' + s.score + '/' + s.max + '</b></td><td>' + esc(dateTime(s.submittedAt)) + '</td></tr>';
    }).join("") + '</table></div>';
}

function teacherLessonsHTML() {
  return '<div class="field"><label>عنوان الدرس</label><input id="nlTitle" placeholder="مثال: Unit 3 — Past Perfect"></div>' +
    '<div class="field"><label>وصف مختصر</label><input id="nlDesc" placeholder="اللي هيتشرح في الدرس"></div>' +
    '<div class="field"><label>روابط فيديوهات يوتيوب (كل رابط في سطر — اختياري)</label><textarea id="nlVideos" rows="2" placeholder="https://youtu.be/..."></textarea></div>' +
    '<div class="field"><label>شرح مكتوب</label><textarea id="nlBody" rows="4" placeholder="اكتب الشرح أو الملزم..."></textarea></div>' +
    '<button class="btn primary" id="addLessonBtn">+ إضافة الدرس</button>' +
    '<div style="margin-top:10px;">' + (db.lessons.length ? db.lessons.slice().reverse().map((l) =>
      '<div class="list-item"><span><b>' + esc(l.title) + '</b> — ' + esc(l.date || "") + (l.videos && l.videos.length ? ' — 🎬 ' + l.videos.length + ' فيديو' : '') + '</span>' +
      '<span class="actions"><button class="btn tiny danger" data-del-lesson="' + esc(l.id) + '">حذف</button></span></div>'
    ).join("") : '<div class="muted">مفيش دروس.</div>') + '</div>';
}

function teacherForumHTML() {
  if (!db.forum.length) return '<div class="muted">المنتدى فاضي.</div>';
  return db.forum.slice().reverse().map((t) =>
    '<div class="list-item"><span><b>' + esc(t.title) + '</b> — ' + esc(t.author) + ' — ' + (t.replies ? t.replies.length : 0) + ' رد</span>' +
    '<span class="actions"><button class="btn tiny danger" data-del-thread="' + esc(t.id) + '">حذف</button></span></div>'
  ).join("");
}

function teacherSettingsHTML() {
  const modelsHTML = Object.keys(AI_MODELS).map((m) =>
    '<option value="' + m + '"' + ((db.settings.aiModel || "gemini-2.5-flash") === m ? " selected" : "") + '>' + esc(AI_MODELS[m]) + '</option>'
  ).join("");
  return '<div class="grid-2">' +
    '<div class="field"><label>كلمة سر اللوحة</label><input id="setPass" value="' + esc(db.settings.teacherPass) + '"></div>' +
    '<div class="field"><label>رقم واتساب المنصة (دولي بدون +)</label><input id="setWa" value="' + esc(db.settings.whatsapp || "") + '" placeholder="201012345678"></div>' +
    '</div>' +
    '<div class="field"><label>إعلان للطلاب (بيظهر في الرئيسية)</label><input id="setBanner" value="' + esc(db.settings.banner || "") + '" placeholder="مثال: امتحان الشهر الأسبوع الجاي — ذاكروا كويس!"></div>' +
    '<div class="grid-2">' +
    '<div class="field"><label>🔑 مفتاح Google AI (Gemini) — للمساعد الذكي ومولد الكويزات</label><input id="setAiKey" value="' + esc(db.settings.aiKey || "") + '" placeholder="الصق المفتاح هنا (يبدأ بـ AIza...)"></div>' +
    '<div class="field"><label>نموذج الذكاء الاصطناعي</label><select id="setAiModel">' + modelsHTML + '</select></div>' +
    '</div>' +
    '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">' +
    '<button class="btn gold" id="testAiBtn">🔌 اختبار المفتاح والاتصال</button>' +
    '<span id="aiTestStatus"></span>' +
    '</div>' +
    '<div class="notice gold">🔑 المفتاح بيتخزن مع بيانات المنصة ويُستخدم من المتصفح مباشرة — احفظه هنا بس ومتشاركش رابط اللوحة مع حد. جيب مفتاحك مجاناً من aistudio.google.com/apikey</div>' +
    '<button class="btn primary" id="saveSettingsBtn">💾 حفظ الإعدادات</button>';
}

function teacherPointsHTML() {
  return '<div class="grid-3">' +
    '<div class="field"><label>اسم المكافأة الجديدة</label><input id="nrName" placeholder="مثال: +10 درجات في كويز"></div>' +
    '<div class="field"><label>السعر بالنقط</label><input type="number" id="nrCost" placeholder="100" min="1"></div>' +
    '<div class="field"><label>الإيموجي</label><input id="nrEmoji" placeholder="🎁" maxlength="4"></div>' +
    '</div>' +
    '<button class="btn primary" id="addRewardBtn">+ إضافة مكافأة</button>' +
    '<div id="adminRewardsList" style="margin-top:8px;"></div>' +
    '<div style="margin-top:16px;border-top:1px dashed var(--line);padding-top:14px;">' +
    '<div class="grid-3">' +
    '<div class="field"><label>نقط يدوية — الطالب</label><select id="ptStudent">' + db.students.map((s) => '<option value="' + esc(s.code) + '">' + esc(s.name) + ' (' + esc(s.code) + ')</option>').join("") + '</select></div>' +
    '<div class="field"><label>العدد (+ إضافة / - خصم)</label><input type="number" id="ptAmount" placeholder="10"></div>' +
    '<div class="field"><label>السبب</label><input id="ptReason" placeholder="مشاركة ممتازة في الحصة"></div>' +
    '</div>' +
    '<button class="btn gold" id="addPointsBtn">⭐ تطبيق النقط</button>' +
    '<div class="notice gold" style="margin-top:12px;margin-bottom:0;">النقط التلقائية: حضور = +3 • كل إجابة صح في كويز = +2 • النوبة الكاملة = +5 إضافية • أول موضوع منتدى = +5</div>' +
    '</div>';
}

function bindTeacherEvents() {
  // طلاب
  $("addStudentBtn").addEventListener("click", async () => {
    const name = $("nsName").value.trim();
    const grade = $("nsGrade").value.trim() || "عام";
    const phone = $("nsPhone").value.trim();
    if (!name) { toast("اكتب اسم الطالب."); return; }
    const code = genCode(grade);
    db.students.push({ id: uid("st"), code, name, grade, phone });
    await saveDB(["students"]);
    renderTeacher();
    toast("✓ اتولد كود الطالب: " + code);
  });
  document.querySelectorAll("[data-copy]").forEach((el) => {
    el.addEventListener("click", () => {
      navigator.clipboard.writeText(el.dataset.copy).then(() => toast("✓ اتنسخ: " + el.dataset.copy)).catch(() => {});
    });
  });
  document.querySelectorAll("[data-del-student]").forEach((b) => {
    b.addEventListener("click", async () => {
      const key = b.dataset.delStudent;
      if (!confirm("حذف الطالب ده؟")) return;
      db.students = db.students.filter((s) => (s.id || s.code) !== key);
      await cloudDelete("students", key);
      touchLocal();
      renderTeacher();
    });
  });

  // حضور
  $("openAttBtn").addEventListener("click", () => {
    openAttendanceSheet($("attDate").value || todayStr(), $("attGrade").value.trim());
  });
  document.querySelectorAll("[data-view-att]").forEach((b) => {
    b.addEventListener("click", () => openAttendanceSheet(b.dataset.viewAtt, ""));
  });

  // مولد الكويز بالذكاء الاصطناعي
  if ($("aiGrade")) {
    fillUnitSelect();
    $("aiGrade").addEventListener("change", fillUnitSelect);
    $("aiGenerateBtn").addEventListener("click", runQuizGeneration);
  }

  // امتحانات
  $("createQuizBtn").addEventListener("click", async () => {
    const title = $("nqTitle").value.trim();
    if (!title) { toast("اكتب عنوان الامتحان."); return; }
    const q = {
      id: uid("qz"), title, desc: $("nqDesc").value.trim(), date: todayStr(),
      questions: [{ q: "السؤال الأول؟", choices: ["", "", "", ""], correct: 0 }]
    };
    db.quizzes.push(q);
    await saveDB(["quizzes"]);
    renderTeacher();
    openQuizEditor(q.id);
  });
  document.querySelectorAll("[data-edit-quiz]").forEach((b) => {
    b.addEventListener("click", () => openQuizEditor(b.dataset.editQuiz));
  });
  document.querySelectorAll("[data-del-quiz]").forEach((b) => {
    b.addEventListener("click", async () => {
      if (!confirm("حذف الامتحان وكل نتايجه؟")) return;
      const id = b.dataset.delQuiz;
      const removedQ = db.quizzes.find((x) => x.id === id);
      db.quizzes = db.quizzes.filter((x) => x.id !== id);
      const removedSubs = db.submissions.filter((s) => s.quizId === id);
      db.submissions = db.submissions.filter((s) => s.quizId !== id);
      if (removedQ) await cloudDelete("quizzes", removedQ.id || removedQ.code);
      for (const rs of removedSubs) await cloudDelete("submissions", rs.id || rs.code);
      touchLocal();
      renderTeacher();
    });
  });

  // شروحات
  $("addLessonBtn").addEventListener("click", async () => {
    const title = $("nlTitle").value.trim();
    if (!title) { toast("اكتب عنوان الدرس."); return; }
    const videos = $("nlVideos").value.split("\n").map((s) => s.trim()).filter(Boolean);
    db.lessons.push({
      id: uid("ls"), title, desc: $("nlDesc").value.trim(),
      date: todayStr(), videos, body: $("nlBody").value.trim()
    });
    await saveDB(["lessons"]);
    renderTeacher();
    toast("✓ تم إضافة الدرس");
  });
  document.querySelectorAll("[data-del-lesson]").forEach((b) => {
    b.addEventListener("click", async () => {
      if (!confirm("حذف الدرس؟")) return;
      const dl = db.lessons.find((x) => x.id === b.dataset.delLesson);
      db.lessons = db.lessons.filter((l) => l.id !== b.dataset.delLesson);
      if (dl) await cloudDelete("lessons", dl.id);
      touchLocal();
      renderTeacher();
    });
  });

  // منتدى
  document.querySelectorAll("[data-del-thread]").forEach((b) => {
    b.addEventListener("click", async () => {
      if (!confirm("حذف الموضوع وردوده؟")) return;
      const dt = db.forum.find((x) => x.id === b.dataset.delThread);
      db.forum = db.forum.filter((t) => t.id !== b.dataset.delThread);
      if (dt) await cloudDelete("forum", dt.id);
      touchLocal();
      renderTeacher();
    });
  });

  // إعدادات + اختبار مفتاح AI
  const testAiBtn = $("testAiBtn");
  if (testAiBtn) {
    testAiBtn.addEventListener("click", async () => {
      const statusEl = $("aiTestStatus");
      // نحفظ المفتاح المؤقت من الحقل عشان الاختبار يجرب اللي كتبه فعلاً
      db.settings.aiKey = $("setAiKey").value.trim();
      db.settings.aiModel = $("setAiModel").value;
      statusEl.innerHTML = '<span class="muted">⏳ جاري الاختبار<span class="spinner-mini"></span></span>';
      testAiBtn.disabled = true;
      const res = await aiTestKey();
      if (res.ok) {
        await saveDB(["settings"]);
        statusEl.innerHTML = '<span class="gen-status-ok">✓ ' + esc(res.msg) + '</span>';
        toast("🤖 الذكاء الاصطناعي شغال دلوقتي!");
      } else {
        statusEl.innerHTML = '<span class="gen-status-err">✗ ' + esc(res.msg) + '</span>';
      }
      testAiBtn.disabled = false;
    });
  }
  $("saveSettingsBtn").addEventListener("click", async () => {
    db.settings.teacherPass = $("setPass").value || db.settings.teacherPass;
    db.settings.whatsapp = $("setWa").value.trim();
    db.settings.banner = $("setBanner").value.trim();
    db.settings.aiKey = $("setAiKey").value.trim();
    db.settings.aiModel = $("setAiModel").value;
    await saveDB(["settings"]);
    toast("✓ تم حفظ الإعدادات" + (db.settings.aiKey ? " — اضغط «اختبار المفتاح» للتأكد إنه شغال" : ""));
    renderTeacher();
  });

  // مكافآت
  $("addRewardBtn").addEventListener("click", async () => {
    const name = $("nrName").value.trim();
    const cost = Number($("nrCost").value);
    const emoji = $("nrEmoji").value.trim() || "🎁";
    if (!name || !cost || cost < 1) { toast("اكتب اسم المكافأة وسعرها بالنقط."); return; }
    db.rewards.push({ id: uid("rw"), name, cost, emoji });
    await saveDB(["rewards"]);
    renderTeacher();
    toast("✓ تمت إضافة المكافأة");
  });

  // نقاط يدوية
  $("addPointsBtn").addEventListener("click", async () => {
    const code = $("ptStudent").value;
    const amount = Number($("ptAmount").value);
    const reason = $("ptReason").value.trim() || "بونص من المستر";
    if (!amount) { toast("اكتب عدد النقط (+ أو -)."); return; }
    const st = db.students.find((s) => s.code === code);
    if (!st) { toast("اختار الطالب الأول."); return; }
    awardPoints(code, st.name, amount, reason);
    await saveDB(["points"]);
    renderTeacher();
    toast("✓ " + (amount > 0 ? "+" : "") + amount + " نقطة لـ " + st.name);
  });

  // طلبات الاستبدال — الربط في renderTeacherAdminExtras

  // نسخة احتياطية
  $("exportBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "منصة-مستر-عادل-" + todayStr() + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  });
  $("importBtnTrigger").addEventListener("click", () => $("importFileInput").click());
  $("importFileInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const imported = JSON.parse(evt.target.result);
        if (!imported || !Array.isArray(imported.students)) throw new Error("ملف غير صالح");
        if (!confirm("هيتم استبدال كل البيانات بالنسخة المستوردة. متأكد؟")) return;
        db = Object.assign(JSON.parse(JSON.stringify(DEFAULT_DB)), imported);
        db.settings = normalizeSettings(imported.settings);
        for (const n of ENTITIES) db[n] = normalizeList(n, db[n]);
        await cloudWriteAll();
        touchLocal();
        renderTeacher();
        toast("✓ تم استيراد النسخة");
      } catch (err) { alert("تعذر قراءة الملف: " + err.message); }
    };
    reader.readAsText(file);
  });
}

function genCode(grade) {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let rnd = "";
  for (let i = 0; i < 4; i++) rnd += letters.charAt(Math.floor(Math.random() * letters.length));
  return "ADEL-" + (grade || "X").replace(/\s+/g, "") + "-" + rnd;
}

/* ============================================================
   الربط والتشغيل
   ============================================================ */
function bindGlobalEvents() {
  $("loginBtn").addEventListener("click", doLogin);
  $("accessCodeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
  $("teacherModeBtn").addEventListener("click", () => { show("teacherView"); });
  $("studentLogoutBtn").addEventListener("click", studentLogout);

  document.querySelectorAll("#studentTabs .tab").forEach((b) => {
    b.addEventListener("click", () => switchTab(b.dataset.tab));
  });

  $("newPostBtn").addEventListener("click", toggleNewPostForm);
  $("submitPostBtn").addEventListener("click", submitNewPost);
  $("cancelPostBtn").addEventListener("click", () => $("newPostForm").classList.add("hidden"));

  // المساعد الذكي
  $("aiSendBtn").addEventListener("click", sendAIMessage);
  $("aiInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendAIMessage(); });

  $("openTeacherFromStudent").addEventListener("click", () => {
    if (teacherUnlocked) {
      $("teacherGate").classList.add("hidden");
      $("teacherContainer").classList.remove("hidden");
      renderTeacher();
      show("teacherView");
    } else {
      show("teacherView");
    }
  });
  $("teacherExitBtn").addEventListener("click", teacherExit);
  $("teacherLoginBtn").addEventListener("click", teacherLogin);
  $("teacherPass").addEventListener("keydown", (e) => { if (e.key === "Enter") teacherLogin(); });
}

async function boot() {
  $("yearNow").textContent = new Date().getFullYear();
  bindGlobalEvents();
  await loadDB();
  watchCloud();
  if (resumeSession()) return;
  show("loginView");
}

boot();
