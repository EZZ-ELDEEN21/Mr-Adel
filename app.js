/* ============================================================
   منصة مستر أحمد سعد — العلوم المتكاملة والفيزياء
   الدخول بالأكواد الرقمية، الشروحات المحمية، الامتحانات،
   المنتدى، ولوحة المستر — مع قفل الحساب على جهاز واحد
   ============================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc, onSnapshot, writeBatch
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import {
  getStorage, ref, uploadBytesResumable, getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-storage.js";

/* ---------- الاتصال بقاعدة البيانات والتخزين ---------- */
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
// ==== البنية: مجموعة لكل كيان (تزامن صحيح بين الأجهزة بدون last-write-wins) ====
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
// التخزين منفصل — لو مش مفعّل ميسقطش قاعدة البيانات معاه
let storage;
try { storage = getStorage(app); } catch (e) { storage = null; }

const DEFAULT_DB = {
  students: [],
  attendance: [],
  quizzes: [],
  submissions: [],
  lessons: [],
  forum: [],
  points: [],
  rewards: [],
  redemptions: [],
  settings: { teacherPass: "adel2026", whatsapp: "", banner: "", aiProvider: "groq", aiKey: "", aiModel: "llama-3.3-70b-versatile" }
};

let db = JSON.parse(JSON.stringify(DEFAULT_DB));
let me = null;          // الطالب الحالي {code,name,grade,phone,...}
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
  const colR = colRef(name);
  for (const item of db[name]) {
    const id = String(item.id || item.code || uid(name.slice(0, 2)));
    const json = JSON.stringify(item);
    const k = name + "/" + id;
    if (savedSnapshot.get(k) === json) continue; // متغيرش → متكتبش
    await setDoc(doc(colR, id), item);
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

/* مسح شامل نهائي: بيمسح كل بيانات المنصة من السحابة + المحلي + يمنع أي جهاز
   يرجّع بياناته القديمة (علم __wipeFlag في الإعدادات — أي جهاز يفتح المنصة
   بعده بينسجم مع السحابة الفاضية ويرمي نسخته المحلية) */
async function wipeEverything() {
  if (cloudAvailable && !cloudBlocked) {
    try {
      // علم المسح الأول في الإعدادات — أي جهاز هيشوفه هيرمي نسخته المحلية
      await setDoc(SETTINGS_REF(), Object.assign({}, db.settings, { __wipeFlag: true }));
      // مسح كل المجموعات بالبناتشات (500 مستند لكل بناتش)
      for (const name of ENTITIES) {
        let snap = await getDocs(colRef(name));
        while (!snap.empty) {
          const batch = writeBatch(firestoreDb);
          let count = 0;
          snap.forEach((d) => { if (count < 450) { batch.delete(d.ref); count++; } });
          await batch.commit();
          snap = await getDocs(colRef(name));
        }
        db[name] = [];
        markAllSaved(name);
      }
      // إعادة الإعدادات نظيفة من غير العلم
      db.settings = normalizeSettings({});
      await setDoc(SETTINGS_REF(), db.settings);
      savedSnapshot.set("@settings", JSON.stringify(db.settings));
    } catch (e) {
      showSave(false, String((e && e.message) || e));
      toast("✗ حصلت مشكلة في المسح من السحابة — جرب تاني.");
      return false;
    }
  } else {
    showSave(false);
  }
  // مسح المحلي بالكامل (بما فيه جلسات الطلاب) — من غير علم محلي عشان
  // بعد كده السحابة فاضية فعلاً ومفيش حاجة ترجع
  try {
    localStorage.removeItem("adel_db");
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(LOGIN_GUARD_KEY);
    localStorage.removeItem(WIPE_FLAG_KEY);
  } catch (e) {}
  me = null;
  return true;
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
  // ⚠ معطّل نهائياً: الترحيل من النسخة القديمة (مستر عادل) كان بيرجّع بيانات
  // المدرس القديم بعد كل حذف — المجموعات adel_* هي المصدر الوحيد دلوقتي.
  return false;
}

async function loadDB() {
  // 1) ابدأ بالحفظ المحلي للجهاز (الحماية من قطع الإنترنت)
  // 2) السحابة فوقه — هي مصدر الحقيقة بعد التحميل
  // 3) حارس نسخة: لو المستر عمل «مسح شامل» من أي جهاز (wipeFlag)،
  //    ممنوع أي جهاز يرجّع بياناته المحلية القديمة — دي كانت مشكلة
  //    «بحذف وبترجع تاني» — السبب: الدمج الذكي كان يرفع الليفي المحلي
  //    القديم على السحابة الفاضية تاني.
  //    اتحسّن: السحابة فاضية + مافيش موافقة دخول محلي جديد = مافيش رفع محلي.
  let staleLocal = false;
  try {
    if (localStorage.getItem(WIPE_FLAG_KEY) === "1") staleLocal = true;
  } catch (e) {}
  try {
    const raw = localStorage.getItem("adel_db");
    if (raw && !staleLocal) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const name of ENTITIES) {
          if (Array.isArray(parsed[name])) db[name] = normalizeList(name, parsed[name]);
        }
        if (parsed.settings) db.settings = normalizeSettings(parsed.settings);
      }
    } else if (raw && staleLocal) {
      // بيانات محلية معلومة إنها بعد مسح شامل — اتمسح من غير ما تتحمل
      try { localStorage.removeItem("adel_db"); } catch (e) {}
    }
  } catch (e) {}
  if (cloudAvailable) {
    try {
      const lists = {};
      for (const name of ENTITIES) lists[name] = await readCollection(name);
      let s = null;
      let wipeFlag = null;
      try {
        const snap = await getDoc(SETTINGS_REF());
        if (snap.exists()) { s = snap.data(); wipeFlag = s.__wipeFlag === true; }
      } catch (e) {}
      const cloudHasData = ENTITIES.some((n) => lists[n].length > 0) || !!s;
      if (wipeFlag) {
        // مسح شامل معمول من جهاز تاني — السحابة هي المتفق عليها (فاضية) والجهاز ده ينسجم معاها
        for (const name of ENTITIES) { db[name] = []; markAllSaved(name); }
        db.settings = normalizeSettings(s || {});
        saveSessionClearedAfterWipe();
        try { localStorage.removeItem(WIPE_FLAG_KEY); } catch (e) {}
        // سجّل إن الفلاج اتحمل (بدون __wipeFlag في الإعدادات المعروضة)
        const cleanSettings = Object.assign({}, db.settings);
        delete cleanSettings.__wipeFlag;
        db.settings = normalizeSettings(cleanSettings);
        try { await setDoc(SETTINGS_REF(), db.settings); } catch (e) {}
      } else if (!cloudHasData) {
        // السحابة فاضية: مافيش أي رفع تلقائي لبيانات محلية (هو ده اللي كان بيرجّع
        // بيانات مستر عادل بعد الحذف) — الاستخدام الجديد يبدأ فاضي ويتكتب بالحفظ الجديد بس.
        for (const name of ENTITIES) { db[name] = []; markAllSaved(name); }
        await cloudWriteSettings();
      } else {
        // سحب البيانات من السحابة — من غير دمج محلي (السحابة مصدر الحقيقة الوحيد)
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
          ? "⚠ الحفظ محلي حالياً — انشر قواعد Firestore (الشرح في لوحة المستر) ليتزامن كل الأجهزة. بياناتك محفوظة ومش هتضيع."
          : "⚠ تعذر الاتصال بقاعدة البيانات — الحفظ محلي مؤقتاً وبياناتك محفوظة.");
      }
    }
  }
  bootSyncDone = true;
  touchLocal();
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
        if (currentTab === "quizzes" && !currentQuiz) renderQuizList();
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

/* ============================================================
   الجلسة الدائمة + قفل الحساب على جهاز واحد
   - الكود بيتحفظ في localStorage (مش sessionStorage) → الريستارت
     أو قفل التاب مابيسألش الكود تاني.
   - أول مرة الطالب يدخل بالكود من جهاز، الجهاز بيتسجل مع الطالب
     (lockedDevice) وأي جهاز تاني بيتمنع نهائياً لحد ما المستر
     يفتح القفل من لوحة التحكم.
   ============================================================ */
const SESSION_KEY = "as_me_v2";
const DEVICE_KEY = "as_device_id";
const LOGIN_GUARD_KEY = "as_login_guard";
const WIPE_FLAG_KEY = "as_wiped_at";

function simpleHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) { h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; }
  return h.toString(16);
}
function deviceKey() {
  let id = null;
  try { id = localStorage.getItem(DEVICE_KEY); } catch (e) {}
  if (!id) {
    id = Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
    try { localStorage.setItem(DEVICE_KEY, id); } catch (e) {}
  }
  return simpleHash(id + "|" + (navigator.userAgent || "") + "|" + (screen.width || 0) + "x" + (screen.height || 0));
}
function deviceLabel() {
  return /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || "") ? "موبايل" : "كمبيوتر";
}
function saveSession(st) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ code: st.code, at: Date.now() })); } catch (e) {}
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
}
function saveSessionClearedAfterWipe() {
  // بعد مسح شامل من جهاز تاني: امسح جلسة الطالب المحلية — مفيش طلاب بعد كده أصلاً
  clearSession();
  try { localStorage.removeItem("adel_db"); } catch (e) {}
}

function loginGuardCheck() {
  let g = null;
  try { g = JSON.parse(localStorage.getItem(LOGIN_GUARD_KEY) || "null"); } catch (e) {}
  const now = Date.now();
  if (g && g.count >= 5 && now - g.first < 60000) {
    return { ok: false, wait: Math.ceil((60000 - (now - g.first)) / 1000) };
  }
  return { ok: true };
}
function loginGuardFail() {
  let g = null;
  try { g = JSON.parse(localStorage.getItem(LOGIN_GUARD_KEY) || "null"); } catch (e) {}
  const now = Date.now();
  if (!g || now - g.first >= 60000) g = { count: 0, first: now };
  g.count++;
  try { localStorage.setItem(LOGIN_GUARD_KEY, JSON.stringify(g)); } catch (e) {}
}
function loginGuardReset() {
  try { localStorage.removeItem(LOGIN_GUARD_KEY); } catch (e) {}
}

/* ---------- شاشة الدخول ---------- */
async function doLogin() {
  const raw = $("accessCodeInput").value.trim();
  const err = $("loginError");
  err.style.display = "none";
  if (!raw) { err.textContent = "اكتب كود الدخول الأول."; err.style.display = "block"; return; }

  const guard = loginGuardCheck();
  if (!guard.ok) {
    err.textContent = "محاولات كتير غلط — استنى " + guard.wait + " ثانية وجرب تاني 🔒";
    err.style.display = "block";
    return;
  }

  const st = db.students.find((s) => String(s.code).trim().toUpperCase() === raw.toUpperCase());
  if (!st) {
    loginGuardFail();
    err.textContent = "الكود ده مش موجود. اتأكد منه أو كلم مستر أحمد سعد.";
    err.style.display = "block";
    return;
  }

  // قفل الجهاز: الحساب بيتقفل على أول جهاز يدخل بيه
  const dk = deviceKey();
  if (st.lockedDevice && st.lockedDevice !== dk) {
    err.innerHTML = "🔒 الحساب ده مقفول على جهاز تاني — مينفعش يتفتح من غير إذن.<br>لو ده جهازك الجديد، كلم مستر أحمد سعد يفتحلك القفل من لوحة التحكم.";
    err.style.display = "block";
    return;
  }
  if (!st.lockedDevice) {
    st.lockedDevice = dk;
    await saveDB(["students"]);
  }

  loginGuardReset();
  me = st;
  saveSession(st);
  openStudent();
}

function resumeSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    const sess = JSON.parse(raw);
    if (!sess || !sess.code) return false;
    const found = db.students.find((s) => String(s.code).trim().toUpperCase() === String(sess.code).trim().toUpperCase());
    if (!found) { clearSession(); return false; }
    // لو الجلسة اتحاولت تتفتح من جهاز غير الجهاز المقفول → امنعها فوراً
    if (found.lockedDevice && found.lockedDevice !== deviceKey()) { clearSession(); return false; }
    me = found;
    openStudent();
    return true;
  } catch { return false; }
}

function studentLogout() {
  me = null;
  clearSession();
  show("loginView");
  $("accessCodeInput").value = "";
}

/* ============================================================
   واجهة الطالب
   ============================================================ */
function openStudent() {
  show("studentView");
  $("studentBadge").textContent = me.name + " — " + (GRADE_SHORT[me.grade] || me.grade);
  $("welcomeName").textContent = "أهلاً يا " + me.name.split(" ")[0] + " 👋";
  $("welcomeMeta").textContent = (GRADE_LABELS[me.grade] || me.grade) + " • كودك: " + me.code + " • جهازك: " + deviceLabel() + " 🔒";
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
  const subs = mySubmissions().filter((s) => !s.training);
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

/* ============================================================
   الشروحات + المشغل المحمي للفيديوهات
   الفيديوهات المرفوعة كملفات بتتعرض بمشغل خاص:
   منع التنزيل + علامة مائية باسم الطالب + إيقاف عند مغادرة النافذة
   ============================================================ */
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
      '<h3 class="section-title">🎬 المحاضرات المرئية (مشغّل محمي)</h3><div class="chips">' +
      l.videos.map((vid, i) =>
        '<button class="btn gold" data-video="' + i + '">▶ ' +
        (typeof vid === "string" ? "الفيديو " + (i + 1) : esc(vid.name || "الفيديو " + (i + 1))) + '</button>'
      ).join(" ") + '</div>' : '') +
    '</div>';
  $("backToLessons").addEventListener("click", renderLessons);
  v.querySelectorAll("[data-video]").forEach((b) => {
    b.addEventListener("click", () => {
      const vid = l.videos[Number(b.dataset.video)];
      if (typeof vid === "string") openVideo(vid, l.title);
      else openProtectedVideo(l, Number(b.dataset.video));
    });
  });
}

function youtubeId(input) {
  const m = String(input).match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : String(input).trim();
}
function openVideo(raw, title) {
  // روابط يوتيوب القديمة (للتوافق مع الدروس القديمة بس)
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

function openProtectedVideo(lesson, idx) {
  const vid = lesson.videos[idx];
  if (!vid || !vid.url) { toast("الفيديو مش متاح حالياً — كلم المستر."); return; }
  const wm = me ? (me.name + " • كود " + me.code + " • " + todayStr()) : "نسخة الطالب";
  const modal = $("videoModal");
  modal.classList.remove("hidden");
  modal.innerHTML =
    '<div class="modal-inner">' +
    '<div class="modal-bar"><b>🎬 ' + esc(lesson.title) + '</b>' +
    '<button class="btn tiny" id="closeVideo">إغلاق ✕</button></div>' +
    '<div class="video-wrap" id="videoWrap">' +
    '<div class="video-watermark" aria-hidden="true">' +
    Array.from({ length: 6 }, () => '<span>' + esc(wm) + '</span>').join("") +
    '</div>' +
    '<video id="protectedVideo" src="' + esc(vid.url) + '" controls preload="metadata" playsinline ' +
    'controlslist="nodownload noplaybackrate noremoteplayback" disablepictureinpicture></video>' +
    '<div class="video-guard hidden" id="videoGuard"><div>🔒 الفيديو اتوقف مؤقتاً' +
    '<span>ارجع للنافذة دي عشان تكمل مشاهدة</span></div></div>' +
    '</div>' +
    '<div class="muted" style="margin-top:8px;">🔒 الفيديو ملك خاص لمنصة مستر أحمد سعد — ممنوع التسجيل أو النشر أو التنزيل، ومسجّل باسمك: ' + esc(wm) + '</div>' +
    '</div>';
  $("closeVideo").addEventListener("click", closeVideo);
  const v = $("protectedVideo");
  v.addEventListener("contextmenu", (e) => e.preventDefault());
  const guard = $("videoGuard");
  guard.addEventListener("click", () => guard.classList.add("hidden"));
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
    score, max: quiz.questions.length, submittedAt: Date.now(), review,
    training: quiz.training === true
  };
  db.submissions.push(sub);
  const earned = quiz.training ? 0 : score * 2 + (score === quiz.questions.length ? 5 : 0);
  if (earned > 0) awardPoints(me.code, me.name, earned, "كويز: " + quiz.title + " (" + score + "/" + quiz.questions.length + ")");
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
    '<div class="forum-meta"><span>👤 ' + esc(t.author) + ' (' + esc(GRADE_SHORT[t.grade] || t.grade || "") + ')</span>' +
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
  { name: "أسطورة الأكاديمية", min: 500, icon: "👑" }
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
  el.innerHTML = esc(me.name + " — " + (GRADE_SHORT[me.grade] || me.grade)) + ' <span class="pts">• ' + pts + ' ⭐</span>';
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
        return '<tr class="rank-' + (i + 1) + '"><td class="rank-cell">' + (i + 1) + '</td><td><b>' + esc(s.name) + '</b> — ' + esc(GRADE_SHORT[s.grade] || s.grade) + '</td><td>' + r.icon + " " + esc(r.name) + '</td><td><b>' + s.pts + '</b> ⭐</td></tr>';
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
    ? '<table><tr><th>#</th><th>الطالب</th><th>الصف</th><th>الرتبة</th><th>النقط</th></tr>' +
      all.map((s, i) => {
        const r = rankOf(s.pts);
        return '<tr class="rank-' + (i + 1) + '"><td class="rank-cell">' + (i + 1) + '</td><td><b>' + esc(s.name) + '</b></td><td>' + esc(GRADE_SHORT[s.grade] || s.grade) + '</td><td>' + r.icon + " " + esc(r.name) + '</td><td><b>' + s.pts + '</b> ⭐</td></tr>';
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
      toast("🎁 اتبعت طلبك لمستر أحمد سعد — استلم مكافأتك في الحصة!");
    });
  });
}

/* ============================================================
   المناهج — منصة مستر أحمد سعد (3 صفوف فقط)
   المصدر: فهارس كتب الوزارة الرسمية المرسلة من المستر نفسه
   (كتاب العلوم المتكاملة 1ث + فيزياء 2 بكالوريا + فيزياء 3ث)
   ============================================================ */
const CURRICULUM = {
  "1Sec": { book: "العلوم المتكاملة 1ث — كتاب الوزارة", terms: [
    { label: "الترم الأول", units: [
      "الوحدة الأولى: النظام البيئي المائي — الغلاف المائي على كوكب الأرض",
      "الوحدة الأولى (تابع): الخواص الكيميائية للماء",
      "الوحدة الأولى (تابع): الخواص الفيزيائية للماء والإحاليل وخصائصها",
      "الوحدة الأولى (تابع): الأهمية البيولوجية للماء وتأثير غازات الهواء والضوء والإشعاع على البيئات المائية",
      "الوحدة الأولى (تابع): التلوان البيولوجي ودور الإنسان في استدامة الحياة المائية",
      "الوحدة الثانية: الغلاف الجوي — مكوّنات وطبقات الغلاف الجوي",
      "الوحدة الثانية (تابع): التفاعلات الكيميائية في الغلاف الجوي والعوامل الفيزيائية وآثارها",
      "الوحدة الثانية (تابع): دور الإنسان في استدامة الغلاف الجوي"
    ] },
    { label: "الترم الثاني", units: [
      "استكمال منهج الوزارة للفصل الدراسي الثاني (بيتحدد بقرار الوزارة — المستر يضيف الدروس من لوحة التحكم)"
    ] }
  ] },
  "2Sec": { book: "الفيزياء 2ث (بكالوريا) — كتاب الوزارة", terms: [
    { label: "الترم الأول", units: [
      "الوحدة الأولى: الكميات الفيزيائية ووحدات القياس — الفصل الأول: القياس الفيزيائي",
      "الوحدة الثانية: الحركة الخطية — الفصل الثاني: الحركة في خط مستقيم",
      "الوحدة الثانية (تابع): الفصل الثالث: القوة والحركة",
      "الوحدة الثالثة: خواص المادة — الفصل الرابع: خواص الموائع المتحركة",
      "الوحدة الثالثة (تابع): الفصل الخامس: خواص الموائع الساكنة",
      "الوحدة الرابعة: الحرارة — الفصل السادس: قوانين الغازات"
    ] },
    { label: "الترم الثاني", units: [
      "استكمال منهج الوزارة للفصل الدراسي الثاني (بيتحدد بقرار الوزارة — المستر يضيف الدروس من لوحة التحكم)"
    ] }
  ] },
  "3Sec": { book: "الفيزياء 3ث — كتاب الوزارة", terms: [
    { label: "الترم الأول", units: [
      "الوحدة الأولى: الكهربية التيارية والكهرومغناطيسية — الفصل الأول: التيار الكهربي وقانونا كيرشوف",
      "الوحدة الأولى (تابع): الفصل الثاني: التناظر المغناطيسي والتيار الكهربي",
      "الوحدة الأولى (تابع): الفصل الثالث: أثر المجال المغناطيسي",
      "الوحدة الأولى (تابع): الفصل الرابع: دوائر الثنار التياري والتردد",
      "الوحدة الثانية: مقدمة في الفيزياء الحديثة — الفصل الخامس: الزخم الزاوي والجسيم",
      "الوحدة الثانية (تابع): الفصل السادس: الأشعّة الكهرومغناطيسية",
      "الوحدة الثانية (تابع): الفصل السابع: المبرر",
      "الوحدة الثانية (تابع): الفصل الثامن: الإلكترونيات الحديثة",
      "أسئلة وتدريبات عامة للمراجعة: ملاحق الأبواب"
    ] },
    { label: "الترم الثاني", units: [
      "استكمال منهج الوزارة للفصل الدراسي الثاني (بيتحدد بقرار الوزارة — المستر يضيف الدروس من لوحة التحكم)"
    ] }
  ] }
};
const GRADE_LABELS = { "1Sec": "الأول الثانوي — علوم متكاملة", "2Sec": "الثاني الثانوي (بكالوريا) — فيزياء", "3Sec": "الثالث الثانوي — فيزياء" };
const GRADE_SHORT = { "1Sec": "1ث علوم متكاملة", "2Sec": "2ث بكالوريا", "3Sec": "3ث فيزياء" };
function currentTermIndex() {
  const m = new Date().getMonth() + 1; // 1-12
  return (m >= 9 || m <= 1) ? 0 : 1;
}

/* ============================================================
   بنك الأسئلة الجاهز — علوم متكاملة وفيزياء
   (بديل مولّد الذكاء الاصطناعي: توليد سريع بدون أي مفتاح،
   والمستر يعدّل الأسئلة بعد التوليد براحته)
   ============================================================ */
const SCIENCE_BANK = {
  "1Sec": [
    { q: "نسبة المياه العذبة من إجمالي مياه الأرض حوالي:", choices: ["3%", "25%", "50%", "97%"], correct: 0 },
    { q: "أعلى كثافة للمياه بتحدث عند درجة حرارة:", choices: ["0°م", "4°م", "25°م", "100°م"], correct: 1 },
    { q: "الخواص المسؤولة عن صعود المياه في النبات من الجذور للأوراق:", choices: ["الشد السطحي والخاصية الشعرية", "الملوحة والضغط", "الحرارة النوعية والتبخر", "اللزوجة والكثافة"], correct: 0 },
    { q: "الماء مذيب عام لإنه جزيئته:", choices: ["ثنائية القطب", "متايدة", "متعادلة تماماً", "أحادية القطب"], correct: 0 },
    { q: "خصائص الماء الفيزيائية اللي بتخلّي الكائنات المائية تعيش تحت الجليد:", choices: ["الجليد أقل كثافة فبيطفو", "الجليد أثقل فبينزل", "الماء بيتجمد من تحت لفوق", "الجليد بيحلل الماء"], correct: 0 },
    { q: "أهم غازات الهواء الذائبة في الماء للكائنات المائية:", choices: ["الأكسجين وثاني أكسيد الكربون", "النيتروجين والهيليوم", "الهيدروجين والميثان", "الأوزون والنيتروجين"], correct: 0 },
    { q: "طبقة الغلاف الجوي اللي بتحمينا من الأشعة فوق البنفسجية:", choices: ["طبقة الأوزون", "التروبوسفير", "الإكسوسفير", "الميزوسفير"], correct: 0 },
    { q: "التفاعل اللي بيتكون فيه الأوزون في طبقة الستراتوسفير:", choices: ["O₂ + O → O₃", "O₃ → O₂ + O", "2H₂ + O₂ → 2H₂O", "CO₂ + H₂O → CH₂O"], correct: 0 },
    { q: "أكبر ملوث للغلاف الجوي نتيجة حرق الوقود في السيارات:", choices: ["أول أكسيد الكربون CO", "الأكسجين O₂", "النيتروجين N₂", "الهيليوم He"], correct: 0 },
    { q: "الحالة اللي بتقل فيها ذوبان الأكسجين في الماء وتخنق الأسماك:", choices: ["زيادة درجة الحرارة", "نقص الحرارة", "زيادة الضغط", "نقص الملوحة"], correct: 0 },
    { q: "مكوّنات النظام البيئي المائي اللي بتصنع غذاءها بنفسها:", choices: ["المنتجات (النباتات المائية والطحالب)", "المستهلكات", "المحللات", "الكائنات الرمية"], correct: 0 },
    { q: "دور الإنسان اللي بيهدد استدامة الحياة المائية أكتر:", choices: ["إلقاء المخلفات الصناعية في الأنهار", "السباحة في النيل", "صيد الأسماك بالقانون", "زراعة النخيل على ضفاف الأنهار"], correct: 0 }
  ],
  "2Sec": [
    { q: "الكميات الفيزيائية المشتقة من الكميات الأساسية (الطول والكتلة والزمن):", choices: ["السرعة والقوة والشغل", "الطول والزمن فقط", "الكتلة ودرجة الحرارة", "المسافة والزمن"], correct: 0 },
    { q: "في التمثيل البياني لحركة بندول في خط مستقيم، الميل بيمثل:", choices: ["السرعة", "التسارع", "القوة", "الإزاحة"], correct: 0 },
    { q: "القوة اللي بتخلي الجسم يقاوم تغير حالته السكونية أو الحركية تعبير عن:", choices: ["القصور الذاتي", "الوزن", "الاحتكاك", "المرونة"], correct: 0 },
    { q: "وفق القانون الثاني للحركة: F = ?", choices: ["m×a", "m×v", "m/a", "m×d"], correct: 0 },
    { q: "حركة الموائع المتحركة بتُشرح بمعادلات:", choices: ["برنولي وريّنولدز", "كيرشوف", "بويل وشارل", "كولوم"], correct: 0 },
    { q: "الضغط عند نقطة في مائع ساكن بيتعلق بـ:", choices: ["العمق والكثافة والجاذبية", "شكل الوعاء وحجمه", "مادة الوعاء ولونه", "زمن السكون"], correct: 0 },
    { q: "قانون بويل للغازات (عند ثبات الحرارة):", choices: ["P × V = ثابت", "V/T = ثابت", "P/T = ثابت", "PV = nRT"], correct: 0 },
    { q: "قوانين الغازات المثالية بتصلح عند:", choices: ["ضغط منخفض ودرجة حرارة عالية", "ضغط عالٍ وحرارة منخفضة", "أي ظروف", "الفراغ التام فقط"], correct: 0 },
    { q: "الجزيئات في الغاز المثالي افتراضياً:", choices: ["حجمها مهمل وتصادماتها مرنة", "حجمها كبير وتتصادم غير مرن", "ثابتة لا تتحرك", "متجاذبة دائماً"], correct: 0 },
    { q: "وحدة قياس الضغط في النظام الدولي:", choices: ["الباسكال (نيوتن/م²)", "الجول", "الواط", "النيوتن"], correct: 0 },
    { q: "القوة اللي بتخلي بالونة المملوءة هليوم ترتفع في الهواء:", choices: ["الرفع (قوة الطفو)", "الجاذبية", "الاحتكاك", "المرونة"], correct: 0 },
    { q: "الحرارة النوعية لأكبر من واحد معناها المادة:", choices: ["محتاجة طاقة أكتر عشان ترتفع درجتها", "بتسخن أسرع من غيرها", "كتلتها أكبر دايماً", "بتتبخر أسرع"], correct: 0 }
  ],
  "3Sec": [
    { q: "قانون الجهد الثاني لكيرشوف بيتعلق بـ:", choices: ["حفظ الطاقة في المسار المغلق", "حفظ الشحنة عند العقدة", "المقاومة النوعية", "القدرة الكهربية"], correct: 0 },
    { q: "اتجاه المجال المغناطيسي حوالين سلك مستقيم بيحمل تيار بيتحدد بـ:", choices: ["قاعدة اليد اليمنى", "قاعدة اليد اليسرى", "قانون هوك", "قانون كولوم"], correct: 0 },
    { q: "القوة المؤثرة على شحنة متحركة في مجال مغناطيسي عمودي على سرعتها:", choices: ["q×v×B", "q×E", "m×a", "q×V"], correct: 0 },
    { q: "التحريض الكهرومغناطيسي اكتشفه:", choices: ["فاراداي", "أوم", "كولوم", "أمبير"], correct: 0 },
    { q: "الزخم الزاوي للإلكترون في ذرة الهيدروجين وفق نموذج بور كمي ويساوي:", choices: ["n×h/2π", "m×v×r ثابت لأي n", "h/2π فقط", "n×h"], correct: 0 },
    { q: "الطيف الكهرومغناطيسي مرتب من أطول موجة لأقصرها:", choices: ["راديو → ميكروويف → ضوئي → سينية → جاما", "جاما → سينية → ضوئي → ميكروويف → راديو", "ضوئي → راديو → جاما", "سينية → راديو → ضوئي"], correct: 0 },
    { q: "الطبيعة الموجية-الجسيمية للضوء بتظهر في:", choices: ["التداخل والانبعاث الضوئي الكهربي معاً", "الانعكاس فقط", "الانكسار فقط", "الاحتكاك"], correct: 0 },
    { q: "أثر كومبتون بيأكد على:", choices: ["الطبيعة الجسيمية للضوء (فوتونات بتتصادم مع إلكترونات)", "الطبيعة الموجية فقط", "قانون أوم", "قانون بويل"], correct: 0 },
    { q: "المواد شبه الموصلة بتوصل الكهرباء:", choices: ["أقل من الفلزات وأكبر من العوازل", "زي الفلزات تماماً", "زي العوازل تماماً", "مفيش توصيل نهائياً"], correct: 0 },
    { q: "إضافة شوائب ثلاثية التكافع للسيليكون بتخلّي المادة من نوع:", choices: ["سالب (P-type)", "موجب (N-type)", "عازلة", "موصلة تماماً"], correct: 0 },
    { q: "الدايود بيسمح بمرور التيار في:", choices: ["اتجاه واحد فقط (التوصيل الأمامي)", "الاتجاهين بالتساوي", "لا اتجاه", "اتجاه عشوائي"], correct: 0 },
    { q: "عند رفع درجة حرارة شبه الموصلة، مقاومته:", choices: ["تقل", "تزيد", "ثابتة", "تصبح صفر"], correct: 0 }
  ]
};
function bankQuizQuestions(grade, count) {
  const pool = (SCIENCE_BANK[grade] || SCIENCE_BANK["1Sec"]).slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  return pool.slice(0, Math.min(count, pool.length))
    .map((x) => ({ q: x.q, choices: x.choices.slice(), correct: x.correct }));
}

/* ============================================================
   الذكاء الاصطناعي — المساعد الذكي بس (الشات)
   مولّد الكويزات بالذكاء الاصطناعي اتحذف — بنك الأسئلة هو البديل
   ============================================================ */
const AI_PROVIDERS = {
  groq: {
    name: "Groq — مجاني وسريع جداً ⭐",
    keyLabel: "مفتاح Groq API (يبدأ بـ gsk_)",
    keyPlaceholder: "gsk_...",
    getKeyUrl: "https://console.groq.com/keys",
    getKeyNote: "تسجيل مجاني بدون كارت ائتمان — الإيميل كفاية",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    models: {
      "llama-3.3-70b-versatile": "Llama 3.3 70B — الأفضل للتعليم (موصى به)",
      "openai/gpt-oss-120b": "GPT-OSS 120B — قوي جداً",
      "openai/gpt-oss-20b": "GPT-OSS 20B — سريع جداً",
      "llama-3.1-8b-instant": "Llama 3.1 8B — أسرع وأخف"
    },
    testOrder: ["llama-3.3-70b-versatile", "openai/gpt-oss-20b", "llama-3.1-8b-instant"]
  },
  openrouter: {
    name: "OpenRouter — نماذج مجانية متعددة",
    keyLabel: "مفتاح OpenRouter (يبدأ بـ sk-or-)",
    keyPlaceholder: "sk-or-v1-...",
    getKeyUrl: "https://openrouter.ai/keys",
    getKeyNote: "مفتاح واحد يفتحلك عشرات النماذج المجانية",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    models: {
      "meta-llama/llama-3.3-70b-instruct:free": "Llama 3.3 70B (مجاني)",
      "deepseek/deepseek-chat-v3-0324:free": "DeepSeek V3 (مجاني)",
      "qwen/qwen-2.5-72b-instruct:free": "Qwen 2.5 72B (مجاني)",
      "google/gemma-3-27b-it:free": "Gemma 3 27B (مجاني)"
    },
    testOrder: ["meta-llama/llama-3.3-70b-instruct:free", "deepseek/deepseek-chat-v3-0324:free", "qwen/qwen-2.5-72b-instruct:free"]
  },
  gemini: {
    name: "Google Gemini (اختياري)",
    keyLabel: "مفتاح Google AI (يبدأ بـ AIza)",
    keyPlaceholder: "AIza...",
    getKeyUrl: "https://aistudio.google.com/apikey",
    getKeyNote: "لو مفضّش جيميناي اختار Groq أو OpenRouter فوق",
    endpoint: "gemini-native",
    models: {
      "gemini-2.5-flash": "Gemini 2.5 Flash — سريع واقتصادي",
      "gemini-2.5-pro": "Gemini 2.5 Pro — أقوى (أبطأ وأغلى)",
      "gemini-2.0-flash": "Gemini 2.0 Flash — قديم لكن مستقر"
    },
    testOrder: ["gemini-2.5-flash", "gemini-2.0-flash"]
  }
};
function aiProvider() {
  const p = (db.settings && db.settings.aiProvider) || "groq";
  return AI_PROVIDERS[p] ? p : "groq";
}
function aiAvailable() {
  return !!(db.settings && String(db.settings.aiKey || "").trim().length >= 20);
}
function aiErrorHint(provider, status, raw) {
  const t = (raw || "").slice(0, 300);
  if (status === 401) return "المفتاح مش صحيح — انسخه تاني كامل من لوحة المزوّد";
  if (status === 403) return "المفتاح ممنوع منه الوصول — اتأكد إنه مفعّل وجرب مفتاح جديد";
  if (status === 404) return "اسم النموذج مش موجود عند المزوّد — اختار نموذج تاني من القائمة";
  if (status === 429) return "تجاوزت الحد المجاني مؤقتاً — استنى دقيقة أو ساعة وجرب تاني";
  if (status === 400 && /json/i.test(t) && /response_format/i.test(t)) return "النموذج ده مش بيدعم وضع JSON — اختار نموذج تاني";
  if (status >= 500) return "مشكلة من سيرفرات المزوّد — جرب تاني بعد شوية";
  return "خطأ من الخدمة (" + status + "): " + t;
}

async function geminiText(systemPrompt, userPrompt) {
  const model = (db.settings && db.settings.aiModel) || "gemini-2.5-flash";
  const key = String(db.settings.aiKey).trim();
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 0.7 }
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
    throw new Error(aiErrorHint("gemini", res.status, errText));
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

async function aiChat(systemPrompt, userPrompt) {
  // الواجهة الموحدة: Groq و OpenRouter (بصيغة OpenAI) + Gemini (صيغته الخاصة)
  const provider = aiProvider();
  if (provider === "gemini") return geminiText(systemPrompt, userPrompt);
  const cfg = AI_PROVIDERS[provider];
  const key = String(db.settings.aiKey || "").trim();
  const model = (db.settings.aiModel && cfg.models[db.settings.aiModel]) ? db.settings.aiModel : Object.keys(cfg.models)[0];
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];
  const body = { model, messages, temperature: 0.7 };
  const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + key };
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = location.origin || "https://mr-ahmed-saad.platform";
    headers["X-Title"] = "Mr Ahmed Saad Science & Physics Platform";
  }
  let res;
  try {
    res = await fetch(cfg.endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (netErr) {
    throw new Error("مشكلة إنترنت — المنصة مش قادرة توصل لسيرفرات " + (provider === "groq" ? "Groq" : "OpenRouter") + ". اتأكد من الاتصال.");
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(aiErrorHint(provider, res.status, errText));
  }
  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) throw new Error("رد فارغ من الذكاء الاصطناعي");
  return text;
}

async function aiTestKey() {
  // اختبار حقيقي: ابعث طلب بسيط وشوف الرد — ولو النموذج مش شغال جرب بدائل
  if (!aiAvailable()) return { ok: false, msg: "مفيش مفتاح — الصق المفتاح الأول" };
  const provider = aiProvider();
  const cfg = AI_PROVIDERS[provider];
  const oldModel = db.settings.aiModel;
  const order = [oldModel, ...cfg.testOrder].filter((m, i, a) => m && a.indexOf(m) === i);
  let lastErr = null;
  for (const m of order) {
    try {
      db.settings.aiModel = m;
      const reply = await aiChat("Reply with exactly: OK", "ping");
      if (reply) {
        return { ok: true, msg: "الاتصال ناجح ✓ — " + m + " شغال", model: m };
      }
    } catch (e) {
      lastErr = e;
    }
  }
  db.settings.aiModel = oldModel;
  return { ok: false, msg: lastErr ? lastErr.message : "فشل الاتصال بكل النماذج" };
}

/* ---------- المساعد الذكي (شخصية العلوم والفيزياء) ---------- */
let aiMessages = [];
const AI_SUGGESTIONS = [
  "ليه الماء أعلى كثافة عند 4 درجة؟",
  "اشرحلي طبقات الغلاف الجوي",
  "قانون بويل وشارل وإزاي أستخدمه؟",
  "اشرحلي قانونا كيرشوف بمثال"
];
function initAI() {
  const status = $("aiStatus");
  if (!status) return;
  if (aiAvailable()) {
    status.textContent = "متصل ✓ (" + (AI_PROVIDERS[aiProvider()].models[db.settings.aiModel] ? db.settings.aiModel : "") + ")";
    status.className = "chip green";
  } else {
    status.textContent = "وضع مبسط (بدون مفتاح AI)";
    status.className = "chip gray";
  }
  if (!$("aiMessages").dataset.seeded) {
    $("aiMessages").dataset.seeded = "1";
    aiMessages.push({ role: "bot", text: "أهلاً يا " + (me ? me.name.split(" ")[0] : "صديقي") + "! 👋 أنا مساعدك الذكي في العلوم والفيزياء 🔬 اسألني أي حاجة في منهجك — علوم متكاملة أو فيزياء — أو حتى أسئلة من كتب خارجية، وهشرحها ليك خطوة خطوة بالعربي." });
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
    (m.role === "bot" ? '<span class="ai-label">🤖 مساعد مستر أحمد سعد</span>' : "") +
    esc(m.role === "bot" ? sanitizeAIReply(m.text) : m.text) + '</div>'
  ).join("");
  box.scrollTop = box.scrollHeight;
}
/* منقّي ردود الـ AI: لو النموذج رجّع كود برمجي (```) أو Markdown غريب
   بينظّفه ويرجّعه نص عادي مناسب للشات */
function sanitizeAIReply(text) {
  let t = String(text || "");
  t = t.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");   // أسوار الكود
  t = t.replace(/^\s*\|.*\|\s*$/gm, (line) => line.replace(/\|/g, " ")); // جداول
  t = t.replace(/^#{1,6}\s+/gm, "");                            // عناوين Markdown
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1"); // غامق/مائل
  t = t.replace(/`([^`]+)`/g, "$1");                            // كود داخلي
  t = t.replace(/^\s*[\-\*]{3,}\s*$/gm, "");                   // خطوط فاصلة
  return t.trim();
}
function aiFallbackReply(q) {
  const lower = q.toLowerCase();
  if (lower.includes("كثافة") || lower.includes("4 درجة") || lower.includes("شرد سطحي") || lower.includes("ماء") || lower.includes("ميه")) {
    return "الماء والخواص الغريبة بتاعته 💧\n• الماء أعلى كثافة عند 4°م — عشان كده الجليد أقل كثافة فيطفو، والكائنات المائية تعيش تحته في الشتا\n• الشد السطحي + الخاصية الشعرية = سبب صعود المياه في النبات من الجذر للورقة\n• جزيئة الماء ثنائية القطب — عشان كده هو مذيب عام لحاجات كتير\nدي من منهج الوحدة الأولى (النظام البيئي المائي) — علوم متكاملة 1ث 📘";
  }
  if (lower.includes("غلاف جوي") || lower.includes("أوزون") || lower.includes("اوزون")) {
    return "الغلاف الجوي ببساطة 🌍\n• طبقاته: التروبوسفير (الطقس) → ستراتوسفير (فيها طبقة الأوزون) → ميزوسفير → ثيرموسفير → إكسوسفير\n• طبقة الأوزون (O₃) بتحمينا من الأشعة فوق البنفسجية المميتة\n• الملوثات زي أول أكسيد الكربون (CO) من حرق الوقود بيقلل الأكسجين النافع\n• دورنا: تقليل الانبعاثات عشان استدامة الغلاف الجوي\nمن منهج الوحدة الثانية — علوم متكاملة 1ث 📘";
  }
  if (lower.includes("بويل") || lower.includes("شارل") || lower.includes("غاز")) {
    return "قوانين الغازات ببساطة (وحدة الحرارة — فيزياء 2 بكالوريا) 🌡️\n• بويل (حرارة ثابتة): P × V = ثابت — تعصر البالونة الضغط يزيد والحجم يقل\n• شارل (ضغط ثابت): V ∝ T — سخّن الغاز يتمدد\n• معادلة الحالة: PV = nRT\n⚠ خد بالك: T لازم تكون بالكلفن (T = t°C + 273)\nوفيه شروط الغاز المثالي: حجم الجزيئات مهمل وتصادماتها مرنة";
  }
  if (lower.includes("كيرشوف") || lower.includes("kirchhoff")) {
    return "قانونا كيرشوف (الكهربية التيارية — فيزياء 3ث) ⚡\n• القانون الأول (الجهد/العقدة): مجموع التيارات الداخلة للعقدة = الخارجة منها — حفظ للشحنة\n• القانون الثاني (العروة): مجموع الرفوع الكهربية في المسار المغلق = مجموع المقاومة × التيار — حفظ للطاقة\n• مثال: دايرة فيها بطارية 12V ومقاومتين 2Ω و 4Ω على التوالي → I = 12/(2+4) = 2 أمبير";
  }
  if (lower.includes("معنى") || lower.includes("ايه معنى") || lower.includes("إيه معنى")) {
    return "أنا في الوضع المبسط مش بقدر أشرح أي حاجة بالتفصيل، بس مستر أحمد سعد يقدر يفعّل الذكاء الاصطناعي الكامل من لوحة التحكم، وساعتها هرد على أي سؤال فوراً! 🚀";
  }
  return "سؤال جميل! 👌 أنا دلوقتي في الوضع المبسط، فإجابتي محدودة. اطلب من مستر أحمد سعد يضيف مفتاح الذكاء الاصطناعي من لوحة التحكم وهجاوبك على أي حاجة بالتفصيل، وبين الوقت اكتب سؤالك في المنتدى وهيرد عليك المستر أو زمايلك.";
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
      const sys = [
        "أنت مساعد تعليمي ودود لطلاب مصر في منصة مستر أحمد سعد.",
        "المواد: العلوم المتكاملة للصف الأول الثانوي، والفيزياء للصف الثاني الثانوي (بكالوريا) والثالث الثانوي.",
        "اعتمد أساساً على منهج وزارة التربية والتعليم المصرية كالتالي:",
        "• علوم متكاملة 1ث ترم أول: كتاب الوزارة فيه وحدتين — الوحدة الأولى (النظام البيئي المائي: الغلاف المائي على كوكب الأرض، الخواص الكيميائية للماء، الخواص الفيزيائية للماء والإحاليل وخصائصها، الأهمية البيولوجية للماء، تأثير غازات الهواء والضوء والإشعاع على البيئات المائية، دور الإنسان في استدامة الحياة المائية) والوحدة الثانية (الغلاف الجوي: مكوّناته وطبقاته، التفاعلات الكيميائية والعوامل الفيزيائية وآثارها، دور الإنسان في استدامته).",
        "• فيزياء 2 بكالوريا ترم أول: كتاب الوزارة فيه 4 وحدات — الكميات الفيزيائية ووحدات القياس (القياس الفيزيائي)، الحركة الخطية (الحركة في خط مستقيم، القوة والحركة)، خواص المادة (خواص الموائع المتحركة، خواص الموائع الساكنة)، الحرارة (قوانين الغازات).",
        "• فيزياء 3ث ترم أول: كتاب الوزارة فيه وحدتين — الكهربية التيارية والكهرومغناطيسية (التيار الكهربي وقانونا كيرشوف، التناظر المغناطيسي والتيار الكهربي، أثر المجال المغناطيسي، دوائر الثنار التيارية والتردد) ومقدمة في الفيزياء الحديثة (الزخم الزاوي والجسيم، الأشعّة الكهرومغناطيسية، المبرر/المضيّئات، الإلكترونيات الحديثة).",
        "لو الطالب سأل عن مواضيع من كتب خارجية أو موسّعة فاشرحها برضه مع ربطها بالمنهج.",
        "قواعد الصياغة الإجبارية:",
        "1) اكتب بالعربية المصرية البسيطة كأنك مدرس بيتكلم مع طالبه — ممنوع نهائياً كتابة أي كود برمجي أو Markdown أو علامات ``` أو JSON أو HTML في الرد.",
        "2) القوانين الرياضية اكتبها كنص عادي مبسط: مثلاً F = m×a أو T = 2π×جذر(L/g) أو PV = nRT — من غير تنسيق كود.",
        "3) حلّل المسائل خطوة بخطوة، واذكر القانون بصيغته ووحدته الصح، وامثّل بمسألة عددية بسيطة لو مناسب، واربط المفاهيم بالحياة اليومية.",
        "4) الإجابة قصيرة ومحفزة (3-8 أسطر).",
        "5) ممنوع أي محتوى غير تعليمي."
      ].join("\n");
      reply = await aiChat(sys, text);
    } catch (e) {
      reply = "⚠ " + (e && e.message ? e.message : "حصلت مشكلة في الاتصال بالذكاء الاصطناعي") + "\nجرب تاني، ولو استمرت المشكلة كلم مستر أحمد سعد يضغط «اختبار المفتاح» في الإعدادات.";
    }
  } else {
    await new Promise((r) => setTimeout(r, 500));
    reply = aiFallbackReply(text);
  }
  typing.remove();
  aiMessages.push({ role: "bot", text: sanitizeAIReply(reply) });
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

function saveStatusHTML() {
  const ok = cloudAvailable && !cloudBlocked;
  const counts = {
    students: db.students.length,
    quizzes: db.quizzes.length,
    submissions: db.submissions.length,
    points: db.points.length,
    forum: db.forum.length,
    lessons: db.lessons.length
  };
  const pill = ok
    ? '<span class="chip green">✓ السحابة شغالة — البيانات بتتزامن على كل الأجهزة</span>'
    : '<span class="chip red">⚠ حفظ محلي فقط — اتبع الخطوات تحت لتشغيل المزامنة</span>';
  const stats = Object.entries(counts).map(([k, v]) =>
    '<span class="chip gray">' + ({students:"طالب",quizzes:"امتحان",submissions:"تسليم",points:"نقطة",forum:"موضوع",lessons:"درس"}[k]) + ': ' + v + '</span>'
  ).join(" ");
  const steps = ok ? "" :
    '<div class="notice" style="margin-top:10px;">' +
    '<b>لتفعيل المزامنة (مرة واحدة بس — 3 دقايق):</b><br>' +
    '1️⃣ افتح <a href="https://console.firebase.google.com" target="_blank" style="color:inherit;font-weight:800;">console.firebase.google.com</a> → مشروع <b>clinic-nour</b><br>' +
    '2️⃣ Firestore Database → تبويب <b>Rules</b><br>' +
    '3️⃣ انسخ القواعد من الزر ده والصقها مكان اللي موجود → اضغط <b>Publish</b> ' +
    '<button class="btn tiny primary" id="copyRulesBtn" style="margin:6px 0;">📋 نسخ القواعد جاهزة</button>' +
    '<div id="rulesCopied" class="muted"></div>' +
    '</div>';
  return '<div class="teacher-section" id="saveStatusBox"><h3>💾 حالة حفظ البيانات</h3>' +
    pill + '<div style="margin-top:8px;">' + stats + '</div>' +
    '<div class="muted" style="margin-top:6px;">الحفظ المحلي دايماً شغال (الـ Refresh مش بيمسح حاجة) — المزامنة بتخلي كل الأجهزة تشوف نفس البيانات لحظياً.</div>' +
    steps + '</div>';
}

function renderTeacher() {
  $("teacherDbMode").textContent = (cloudAvailable && !cloudBlocked) ? "متصل بالسحابة ✓" : "حفظ محلي";
  const c = $("teacherContainer");
  c.innerHTML =
    saveStatusHTML() +
    '<div class="notice gold">📌 الأكواد دي هي اللي تتوزع على الطلاب — كل طالب بيكتب كوده الرقمي في صفحة الدخول، والحساب بيتقفل على أول جهاز يدخل بيه.</div>' +
    sectionCard("إحصائيات سريعة", teacherStatsHTML()) +
    sectionCard("الطلاب والأكواد", teacherStudentsHTML()) +
    sectionCard("⭐ النقط والمكافآت", teacherPointsHTML()) +
    sectionCard("📨 طلبات استبدال المكافآت", '<div id="redemptionList"></div>') +
    sectionCard("الحضور", teacherAttendanceHTML()) +
    sectionCard("الامتحانات والكويزات", teacherQuizzesHTML()) +
    sectionCard("النتائج", teacherResultsHTML()) +
    sectionCard("الشروحات والفيديوهات", teacherLessonsHTML()) +
    sectionCard("المنتدى", teacherForumHTML()) +
    sectionCard("الإعدادات", teacherSettingsHTML()) +
    sectionCard("نسخة احتياطية",
      '<button class="btn primary" id="exportBtn">⬇ تنزيل نسخة JSON</button> ' +
      '<button class="btn ghost" id="importBtnTrigger">⬆ استيراد نسخة</button>' +
      '<input type="file" id="importFileInput" accept="application/json" class="hidden">'
    ) +
    sectionCard("🧹 منطقة الخطر — مسح شامل",
      '<div class="notice" style="color:var(--danger);border-color:#eaccc4;background:#fbeae6;">' +
      'الزر ده بيمسح <b>كل بيانات المنصة نهائياً</b> من السحابة ومن كل الأجهزة: الطلاب، النتايج، الحضور، الامتحانات، الدروس، المنتدى، والنقط — ' +
      'ومش هترجع تاني من أي جهاز. استخدمه مرة واحدة بس في بداية العام للانتقال من بيانات المدرس القديم.' +
      '</div>' +
      '<button class="btn danger block" id="wipeAllBtn">🗑️ مسح شامل نهائي لكل بيانات المنصة</button>'
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
  const gradeOptions = Object.keys(CURRICULUM).map((g) =>
    '<option value="' + g + '">' + esc(GRADE_LABELS[g]) + '</option>'
  ).join("");
  return '<div class="grid-2">' +
    '<div class="field"><label>اسم الطالب</label><input id="nsName" placeholder="مثال: أحمد محمد"></div>' +
    '<div class="field"><label>الصف (اختار من القائمة)</label><select id="nsGrade">' + gradeOptions + '</select></div>' +
    '</div>' +
    '<div class="field"><label>رقم واتساب ولي الأمر (اختياري — عشان يوصلك كود الطالب)</label><input id="nsPhone" placeholder="01xxxxxxxxx"></div>' +
    '<button class="btn primary" id="addStudentBtn">+ إضافة طالب وتوليد كود رقمي</button>' +
    '<div class="notice">الأكواد أرقام بس (6 خانات) عشان تبقى سهلة على الطلاب — اضغط على الكود لنسخه، وزر الواتساب لتبعت الكود لولي الأمر.<br>🔒 الحساب بيتقفل على أول جهاز يدخل بالكود — ولو الطالب غير موبيله، اضغط «فتح القفل» جنبه.</div>' +
    '<div id="studentsList">' + db.students.map((s) => {
      const digits = String(s.phone || "").replace(/\D/g, "");
      const wa = digits ? (digits.startsWith("20") ? digits : digits.startsWith("0") ? "2" + digits : "20" + digits) : "";
      const lockChip = s.lockedDevice
        ? '<span class="chip red">🔒 مقفول على جهاز (' + esc(s.lockedDevice || "") + ')</span>'
        : '<span class="chip gray">لسه مفيش قفل جهاز</span>';
      return '<div class="list-item"><span><b>' + esc(s.name) + '</b> — ' + esc(GRADE_SHORT[s.grade] || s.grade) +
        ' <span class="code-pill" data-copy="' + esc(s.code) + '" style="cursor:pointer;">' + esc(s.code) + '</span> ' + lockChip + '</span>' +
        '<span class="actions">' +
        (wa ? '<a class="btn tiny ghost" target="_blank" href="https://wa.me/' + wa + '?text=' + encodeURIComponent("مرحباً، كود دخول الطالب " + s.name + " لمنصة مستر أحمد سعد: " + s.code + " (أرقام بس)") + '">📱 واتساب</a>' : '') +
        (s.lockedDevice ? '<button class="btn tiny ghost" data-unlock-device="' + esc(s.id || s.code) + '">🔓 فتح قفل الجهاز</button>' : '') +
        '<button class="btn tiny danger" data-del-student="' + esc(s.id || s.code) + '">حذف</button></span></div>';
    }).join("") + '</div>';
}

function teacherAttendanceHTML() {
  const dates = [...new Set(db.attendance.map((a) => a.date))].sort().reverse();
  const gradeOptions = Object.keys(CURRICULUM).map((g) =>
    '<option value="' + g + '">' + esc(GRADE_LABELS[g]) + '</option>'
  ).join("");
  return '<div class="grid-3">' +
    '<div class="field"><label>تاريخ الحصة</label><input type="date" id="attDate" value="' + todayStr() + '"></div>' +
    '<div class="field"><label>الصف (اختياري)</label><select id="attGrade"><option value="">كل الصفوف</option>' + gradeOptions + '</select></div>' +
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
      return '<div class="list-item"><span><b>' + esc(s.name) + '</b> — ' + esc(GRADE_SHORT[s.grade] || s.grade) + ' (' + esc(s.code) + ')</span>' +
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
  const gradeOptions = Object.keys(CURRICULUM).map((g) =>
    '<option value="' + g + '">' + esc(GRADE_LABELS[g]) + '</option>'
  ).join("");
  return '<div class="field"><label>عنوان الامتحان/الكويز</label><input id="nqTitle" placeholder="مثال: كويز الحركة التوافقية البسيطة"></div>' +
    '<div class="field"><label>وصف مختصر (اختياري)</label><input id="nqDesc" placeholder="المدة، المنهج..."></div>' +
    '<button class="btn primary" id="createQuizBtn">+ إنشاء امتحان يدوي جديد</button>' +
    '<div style="margin-top:10px;">' + (db.quizzes.length ? db.quizzes.slice().reverse().map((q) =>
      '<div class="list-item"><span><b>' + esc(q.title) + '</b> — ' + q.questions.length + ' سؤال — ' + esc(q.date || "") + '</span>' +
      '<span class="actions">' +
      '<button class="btn tiny ghost" data-edit-quiz="' + esc(q.id) + '">تعديل الأسئلة</button>' +
      '<button class="btn tiny danger" data-del-quiz="' + esc(q.id) + '">حذف</button></span></div>'
    ).join("") : '<div class="muted">مفيش امتحانات.</div>') + '</div>' +
    '<div id="quizEditor"></div>' +
    '<h4 class="ai-quiz-heading">📦 توليد كويز من بنك الأسئلة الجاهز</h4>' +
    '<div class="ai-quiz-box">' +
    '<div class="grid-3">' +
    '<div class="field"><label>الصف</label><select id="bankGrade">' + gradeOptions + '</select></div>' +
    '<div class="field"><label>الترم</label><select id="bankTerm"></select></div>' +
    '<div class="field"><label>عدد الأسئلة</label><select id="bankCount"><option>5</option><option selected>8</option><option>10</option></select></div>' +
    '</div>' +
    '<div class="muted" style="margin-bottom:10px;">الأسئلة من بنك جاهز على منهج الوزارة — وبعد التوليد تعدّل أي سؤال وتضيف من عندك براحتك. (مولّد الذكاء الاصطناعي للكويزات اتشال — الذكاء الاصطناعي فاضل للمساعد الذكي في الشات بس)</div>' +
    '<button class="btn gold block" id="bankGenerateBtn">📦 توليد الكويز</button>' +
    '<div id="bankGenStatus" class="muted" style="margin-top:8px;"></div>' +
    '</div>';
}

function fillBankTermSelect() {
  const gradeSel = $("bankGrade");
  const termSel = $("bankTerm");
  if (!gradeSel || !termSel) return;
  const c = CURRICULUM[gradeSel.value];
  if (!c) return;
  const cur = currentTermIndex();
  termSel.innerHTML = c.terms.map((t, i) =>
    '<option value="' + i + '"' + (i === cur ? " selected" : "") + '>' + esc(t.label) + '</option>'
  ).join("");
}

async function runBankGeneration() {
  const btn = $("bankGenerateBtn");
  const status = $("bankGenStatus");
  const grade = $("bankGrade").value;
  const termIdx = Number($("bankTerm").value || 0);
  const count = Number($("bankCount").value);
  const c = CURRICULUM[grade];
  if (!c) { status.innerHTML = '<span class="gen-status-err">اختار الصف الأول.</span>'; return; }
  btn.disabled = true;
  status.innerHTML = '⏳ جاري تجهيز الأسئلة من البنك<span class="spinner-mini"></span>';
  await new Promise((r) => setTimeout(r, 300));
  const questions = bankQuizQuestions(grade, count);
  if (!questions.length) {
    status.innerHTML = '<span class="gen-status-err">البنك فاضي للصف ده — كلم فريق المنصة.</span>';
    btn.disabled = false;
    return;
  }
  const termLabel = c.terms[termIdx] ? c.terms[termIdx].label : "";
  const quiz = {
    id: uid("qz"),
    title: "📦 " + (GRADE_LABELS[grade] || grade) + " — " + termLabel,
    desc: "كويز من بنك الأسئلة الجاهز • " + c.book + " • " + termLabel + " • عدّل الأسئلة براحتك",
    date: todayStr(),
    questions,
    generatedBy: "bank",
    gradeTag: grade,
    termIdx
  };
  db.quizzes.push(quiz);
  await saveDB(["quizzes"]);
  status.innerHTML = '<span class="gen-status-ok">✓ اتولد «' + esc(quiz.title) + '» بـ ' + questions.length + ' سؤال — عدّله من زر «تعديل الأسئلة».</span>';
  renderTeacher();
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
  return '<div class="table-wrap"><table><tr><th>الطالب</th><th>الصف</th><th>الامتحان</th><th>الدرجة</th><th>التاريخ</th></tr>' +
    db.submissions.slice().reverse().map((s) => {
      const q = db.quizzes.find((x) => x.id === s.quizId);
      return '<tr><td>' + esc(s.name) + '</td><td>' + esc(GRADE_SHORT[s.grade] || s.grade) + '</td><td>' + esc(q ? q.title : "—") + '</td>' +
        '<td><b>' + s.score + '/' + s.max + '</b></td><td>' + esc(dateTime(s.submittedAt)) + '</td></tr>';
    }).join("") + '</table></div>';
}

function teacherLessonsHTML() {
  return '<div class="field"><label>عنوان الدرس</label><input id="nlTitle" placeholder="مثال: الحركة التوافقية البسيطة"></div>' +
    '<div class="field"><label>وصف مختصر</label><input id="nlDesc" placeholder="اللي هيتشرح في الدرس"></div>' +
    '<div class="field"><label>🎬 فيديو الشرح — ملف من جهازك (MP4 ويُفضّل أقل من 500 ميجا)</label><input type="file" id="nlVideoFile" accept="video/*"></div>' +
    '<div id="nlUploadStatus" class="muted"></div>' +
    '<div class="field"><label>روابط يوتيوب قديمة (اختياري — كل رابط في سطر)</label><textarea id="nlVideos" rows="2" placeholder="https://youtu.be/..."></textarea></div>' +
    '<div class="field"><label>شرح مكتوب</label><textarea id="nlBody" rows="4" placeholder="اكتب الشرح أو الملزم..."></textarea></div>' +
    '<button class="btn primary" id="addLessonBtn">+ إضافة الدرس</button>' +
    '<div class="notice" style="margin-top:10px;">🔒 الفيديو بيتخزن على المنصة نفسها (مش يوتيوب) وبيتعرض بمشغّل محمي: منع زرار التنزيل + منع كليك يمين + علامة مائية باسم الطالب وكوده + إيقاف تلقائي لو الطالب خرج من النافذة. الحماية المطلقة ضد التصوير مش ممكنة تقنياً في المتصفح، بس دي أقوى وسائل التأمين المتاحة.</div>' +
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
  const p = aiProvider();
  const cfg = AI_PROVIDERS[p];
  const currentModel = db.settings.aiModel && cfg.models[db.settings.aiModel] ? db.settings.aiModel : Object.keys(cfg.models)[0];
  const providersHTML = Object.keys(AI_PROVIDERS).map((k) =>
    '<option value="' + k + '"' + (p === k ? " selected" : "") + '>' + esc(AI_PROVIDERS[k].name) + '</option>'
  ).join("");
  const modelsHTML = Object.keys(cfg.models).map((m) =>
    '<option value="' + m + '"' + (currentModel === m ? " selected" : "") + '>' + esc(cfg.models[m]) + '</option>'
  ).join("");
  return '<div class="grid-2">' +
    '<div class="field"><label>كلمة سر اللوحة</label><input id="setPass" value="' + esc(db.settings.teacherPass) + '"></div>' +
    '<div class="field"><label>رقم واتساب المنصة (دولي بدون +)</label><input id="setWa" value="' + esc(db.settings.whatsapp || "") + '" placeholder="201012345678"></div>' +
    '</div>' +
    '<div class="field"><label>إعلان للطلاب (بيظهر في الرئيسية)</label><input id="setBanner" value="' + esc(db.settings.banner || "") + '" placeholder="مثال: امتحان الشهر الأسبوع الجاي — ذاكروا كويس!"></div>' +
    '<h4 class="ai-quiz-heading" style="margin-top:16px;">🤖 المساعد الذكي (الشات)</h4>' +
    '<div class="field"><label>المزوّد — جيميناي مش إجباري!</label><select id="setAiProvider">' + providersHTML + '</select></div>' +
    '<div class="grid-2">' +
    '<div class="field"><label>🔑 ' + esc(cfg.keyLabel) + '</label><input id="setAiKey" value="' + esc(db.settings.aiKey || "") + '" placeholder="' + esc(cfg.keyPlaceholder) + '"></div>' +
    '<div class="field"><label>النموذج</label><select id="setAiModel">' + modelsHTML + '</select></div>' +
    '</div>' +
    '<div class="notice gold">🆓 جيب مفتاحك مجاناً من <a href="' + cfg.getKeyUrl + '" target="_blank" style="color:inherit;font-weight:800;">' + cfg.getKeyUrl.replace("https://", "") + '</a> — ' + esc(cfg.getKeyNote) + '. المفتاح بيتخزن مع إعدادات المنصة ومتشاركش رابط اللوحة مع حد. المساعد الذكي بيجاوب على المنهج وبيوسّع من كتب خارجية لو الطالب سأل.</div>' +
    '<h4 class="ai-quiz-heading">🔐 قواعد Storage للفيديوهات</h4>' +
    '<div class="notice" style="margin-bottom:10px;">الفيديوهات المرفوعة بتتخزن في Firebase Storage. انشر قواعدها مرة واحدة: Firebase Console → <b>Build → Storage → Rules</b> → انسخ والصق → Publish.' +
    '<button class="btn tiny primary" id="copyStorageBtn" style="margin:6px 0;display:block;">📋 نسخ قواعد Storage</button>' +
    '<div id="storageCopied" class="muted"></div></div>' +
    '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">' +
    '<button class="btn gold" id="testAiBtn">🔌 اختبار المفتاح والاتصال</button>' +
    '<span id="aiTestStatus"></span>' +
    '</div>' +
    '<button class="btn primary block" id="saveSettingsBtn" style="margin-top:14px;">💾 حفظ الإعدادات</button>';
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
  // نسخ قواعد Firestore جاهزة
  const copyRulesBtn = $("copyRulesBtn");
  if (copyRulesBtn) {
    copyRulesBtn.addEventListener("click", async () => {
      try {
        const res = await fetch("firestore.rules");
        const txt = await res.text();
        await navigator.clipboard.writeText(txt);
        $("rulesCopied").innerHTML = '<span class="gen-status-ok">✓ اتنسخت! روح Firebase → Rules → الصق → Publish</span>';
      } catch (e) {
        $("rulesCopied").innerHTML = '<span class="gen-status-err">انسخها يدوياً من ملف firestore.rules في المشروع</span>';
      }
    });
  }
  // نسخ قواعد Storage جاهزة (للفيديوهات)
  const copyStorageBtn = $("copyStorageBtn");
  if (copyStorageBtn) {
    copyStorageBtn.addEventListener("click", async () => {
      try {
        const res = await fetch("storage.rules");
        const txt = await res.text();
        await navigator.clipboard.writeText(txt);
        $("storageCopied").innerHTML = '<span class="gen-status-ok">✓ اتنسخت! روح Firebase → Storage → Rules → الصق → Publish</span>';
      } catch (e) {
        $("storageCopied").innerHTML = '<span class="gen-status-err">انسخها يدوياً من ملف storage.rules في المشروع</span>';
      }
    });
  }
  // طلاب
  $("addStudentBtn").addEventListener("click", async () => {
    const name = $("nsName").value.trim();
    const grade = $("nsGrade").value;
    const phone = $("nsPhone").value.trim();
    if (!name) { toast("اكتب اسم الطالب."); return; }
    if (!grade || !GRADE_LABELS[grade]) { toast("اختار صف الطالب من القائمة."); return; }
    const code = genCode();
    db.students.push({ id: uid("st"), code, name, grade, phone });
    await saveDB(["students"]);
    renderTeacher();
    toast("✓ كود الطالب الرقمي: " + code);
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
  // فتح قفل جهاز طالب (لو غير موبيله أو غير جهازه)
  document.querySelectorAll("[data-unlock-device]").forEach((b) => {
    b.addEventListener("click", async () => {
      if (!confirm("فتح قفل الجهاز للطالب ده؟ أي جهاز يدخل بالكود بعد كده هيتقفل عليه.")) return;
      const st = db.students.find((s) => (s.id || s.code) === b.dataset.unlockDevice);
      if (st) {
        st.lockedDevice = null;
        await saveDB(["students"]);
        renderTeacher();
        toast("✓ اتحرر القفل — الطالب يقدر يدخل من جهاز جديد وهيتقفل عليه.");
      }
    });
  });

  // حضور
  $("openAttBtn").addEventListener("click", () => {
    openAttendanceSheet($("attDate").value || todayStr(), $("attGrade").value);
  });
  document.querySelectorAll("[data-view-att]").forEach((b) => {
    b.addEventListener("click", () => openAttendanceSheet(b.dataset.viewAtt, ""));
  });

  // بنك الأسئلة الجاهز
  if ($("bankGrade")) {
    fillBankTermSelect();
    $("bankGenerateBtn").addEventListener("click", runBankGeneration);
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

  // شروحات + رفع فيديو كملف
  $("addLessonBtn").addEventListener("click", async () => {
    const title = $("nlTitle").value.trim();
    if (!title) { toast("اكتب عنوان الدرس."); return; }
    const fileInput = $("nlVideoFile");
    const file = fileInput && fileInput.files ? fileInput.files[0] : null;
    const ytLinks = $("nlVideos").value.split("\n").map((s) => s.trim()).filter(Boolean);
    const videos = [];
    if (file) {
      const statusEl = $("nlUploadStatus");
      try {
        const meta = await uploadLessonVideo(file, statusEl);
        videos.push(meta);
        statusEl.innerHTML = '<span class="gen-status-ok">✓ الفيديو اترفع بنجاح واتحفظ على المنصة</span>';
      } catch (e) {
        statusEl.innerHTML = '<span class="gen-status-err">✗ ' + esc((e && e.message) || "فشل الرفع") + '</span>';
        toast("✗ " + ((e && e.message) || "فشل رفع الفيديو"));
        return;
      }
    }
    for (const link of ytLinks) videos.push(link);
    db.lessons.push({
      id: uid("ls"), title, desc: $("nlDesc").value.trim(),
      date: todayStr(), videos, body: $("nlBody").value.trim()
    });
    await saveDB(["lessons"]);
    renderTeacher();
    toast("✓ تم إضافة الدرس" + (file ? " وفيديو الشرح المحمي 🔒" : ""));
  });
  document.querySelectorAll("[data-del-lesson]").forEach((b) => {
    b.addEventListener("click", async () => {
      if (!confirm("حذف الدرس؟ (الفيديو هيفضل متاح في Storage — تقدر تحذفه يدوياً من Firebase Console)")) return;
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

  // إعدادات + مزوّد AI + اختبار المفتاح
  const providerSel = $("setAiProvider");
  if (providerSel) {
    providerSel.addEventListener("change", () => {
      // تغيير المزوّد يعيد رسم القسم بنماذجه ومفتاحه الصح
      db.settings.aiProvider = providerSel.value;
      db.settings.aiModel = Object.keys(AI_PROVIDERS[providerSel.value].models)[0];
      renderTeacher();
    });
  }
  const testAiBtn = $("testAiBtn");
  if (testAiBtn) {
    testAiBtn.addEventListener("click", async () => {
      const statusEl = $("aiTestStatus");
      // نحفظ الإعدادات المؤقتة من الحقول عشان الاختبار يجرب اللي كتبه فعلاً
      db.settings.aiKey = $("setAiKey").value.trim();
      db.settings.aiModel = $("setAiModel").value;
      statusEl.innerHTML = '<span class="muted">⏳ جاري الاختبار<span class="spinner-mini"></span></span>';
      testAiBtn.disabled = true;
      const res = await aiTestKey();
      if (res.ok) {
        await saveDB(["settings"]);
        statusEl.innerHTML = '<span class="gen-status-ok">✓ ' + esc(res.msg) + '</span>';
        toast("🤖 المساعد الذكي شغال دلوقتي!");
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
    db.settings.aiProvider = $("setAiProvider").value;
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
    a.download = "منصة-مستر-احمد-سعد-" + todayStr() + ".json";
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

  // مسح شامل نهائي — مع تأكيد مزدوج
  const wipeBtn = $("wipeAllBtn");
  if (wipeBtn) {
    wipeBtn.addEventListener("click", async () => {
      if (!confirm("⚠️ تحذير نهائي: هيتم مسح كل بيانات المنصة من السحابة ومن كل الأجهزة (طلاب، نتائج، حضور، امتحانات، دروس، منتدى، نقط) ومش هترجع تاني. متأكد؟")) return;
      if (!confirm("تأكيد أخير: اكتب «مسح» في بالك — هل عايز تمسح كل حاجة فوراً؟")) return;
      wipeBtn.disabled = true;
      wipeBtn.textContent = "⏳ جاري المسح الشامل...";
      const ok = await wipeEverything();
      if (ok) {
        toast("✓ اتمسح كل حاجة — المنصة فاضية وجاهزة لبداية جديدة");
        teacherUnlocked = false;
        $("teacherGate").classList.remove("hidden");
        $("teacherContainer").classList.add("hidden");
        $("teacherPass").value = "";
        show("teacherView");
      }
      wipeBtn.disabled = false;
      wipeBtn.textContent = "🗑️ مسح شامل نهائي لكل بيانات المنصة";
    });
  }
}

/* كود الطالب: أرقام فقط (6 خانات) — سهل للحفظ والكتابة */
function genCode() {
  for (let tries = 0; tries < 50; tries++) {
    const c = String(Math.floor(100000 + Math.random() * 900000));
    const exists = db.students.some((s) => String(s.code) === c);
    if (!exists) return c;
  }
  return String(Date.now()).slice(-8);
}

/* ============================================================
   رفع الفيديوهات — ملفات على Firebase Storage (مش يوتيوب)
   ============================================================ */
function videoErrorHint(err) {
  const code = String((err && err.code) || "");
  if (/unauthorized|permission|storage\/unauthorized/i.test(code)) return "قواعد Storage مش منشورة — انسخها من زر «نسخ قواعد Storage» في الإعدادات وانشرها في Firebase Console → Storage → Rules.";
  if (/canceled/i.test(code)) return "الرفع اتلغي.";
  if (/quota|bucket/i.test(code)) return "مشكلة مساحة تخزين — راجع Firebase Console → Storage.";
  if (/retry/i.test(code)) return "الإنترنت قطع أثناء الرفع — جرب تاني.";
  return "فشل رفع الفيديو: " + ((err && err.message) || "خطأ غير معروف");
}
async function uploadLessonVideo(file, statusEl) {
  if (!storage) throw new Error("خدمة الملفات مش متاحة — اتأكد من إن Storage مفعّل في مشروع Firebase.");
  if (file.size > 500 * 1024 * 1024) throw new Error("الفيديو أكبر من 500 ميجا — قلّل جودته أو قسمه لأجزاء.");
  const safeName = "videos/" + Date.now() + "_" + String(file.name).replace(/[^\w.\-\u0600-\u06FF ]+/g, "_");
  const pathRef = ref(storage, safeName);
  const task = uploadBytesResumable(pathRef, file, { contentType: file.type || "video/mp4" });
  return new Promise((resolve, reject) => {
    task.on("state_changed",
      (snap) => {
        if (statusEl) {
          const pct = Math.round((snap.bytesTransferred / Math.max(1, snap.totalBytes)) * 100);
          statusEl.innerHTML = '⏳ جاري رفع الفيديو... ' + pct + '% <span class="spinner-mini"></span>';
        }
      },
      (err) => reject(new Error(videoErrorHint(err))),
      async () => {
        try {
          const url = await getDownloadURL(task.snapshot.ref);
          resolve({
            kind: "file", name: file.name, size: file.size,
            type: file.type || "video/mp4", path: safeName, url, uploadedAt: Date.now()
          });
        } catch (e) { reject(new Error(videoErrorHint(e))); }
      }
    );
  });
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

  // ===== حماية الفيديوهات والمحتوى =====
  // منع كليك يمين على الفيديو
  document.addEventListener("contextmenu", (e) => {
    const modal = $("videoModal");
    if (e.target && e.target.tagName === "VIDEO") { e.preventDefault(); return; }
    if (modal && !modal.classList.contains("hidden") && modal.contains(e.target)) e.preventDefault();
  });
  // إيقاف الفيديو لو الطالب غيّر التاب أو صفحة تانية (تصدير لقطة شاشة)
  document.addEventListener("visibilitychange", () => {
    const v = $("protectedVideo");
    if (!v) return;
    if (document.hidden) {
      if (!v.paused) v.pause();
      const g = $("videoGuard"); if (g) g.classList.remove("hidden");
    }
  });
  window.addEventListener("blur", () => {
    const v = $("protectedVideo");
    if (v && !v.paused) v.pause();
    const g = $("videoGuard"); if (g) g.classList.remove("hidden");
  });
  window.addEventListener("focus", () => {
    const g = $("videoGuard"); if (g) g.classList.add("hidden");
  });
  // تنبيه عند محاولة PrintScreen (إجراء تخفيفي — مش حماية كاملة)
  document.addEventListener("keyup", (e) => {
    if (e.key === "PrintScreen" || e.code === "PrintScreen") {
      toast("📸 ممنوع أخد لقطات شاشة من المنصة — الفيديوهات مسجلة باسمك.");
      try { navigator.clipboard.writeText(" ").catch(() => {}); } catch (e2) {}
    }
  });
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
