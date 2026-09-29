/* ============================================================
   منصة مستر عادل عزت — منطق التطبيق
   الدخول بالأكواد، الشروحات، الامتحانات، المنتدى، ولوحة المستر
   ============================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc
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

let cloudAvailable = true;
let app, firestoreDb, DOC_REF;
try {
  app = initializeApp(firebaseConfig);
  firestoreDb = getFirestore(app);
  DOC_REF = doc(firestoreDb, "academy", "adelEzzat");
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
  settings: { teacherPass: "adel2026", whatsapp: "", banner: "" }
};

let db = JSON.parse(JSON.stringify(DEFAULT_DB));
let me = null;          // الطالب الحالي {code,name,grade,phone}
let teacherUnlocked = false;
let currentTab = "home";
let currentQuiz = null; // {quiz, answers}
let currentThread = null;
let cloudErrorShown = false;

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

function localSave() {
  try { localStorage.setItem("adel_db", JSON.stringify(db)); } catch {}
}
function localLoad() {
  try {
    const raw = localStorage.getItem("adel_db");
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return false;
    db = Object.assign(JSON.parse(JSON.stringify(DEFAULT_DB)), parsed);
    db.settings = Object.assign({}, DEFAULT_DB.settings, parsed.settings || {});
    return true;
  } catch { return false; }
}

function showSave(ok, detail) {
  if (ok) return;
  if (!cloudAvailable && !cloudErrorShown) {
    cloudErrorShown = true;
    toast("⚠ وضع بدون إنترنت: البيانات محفوظة محلياً على الجهاز ده بس.");
  }
}
function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast-msg";
  el.textContent = msg;
  el.style.cssText = "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:999;background:#0f2f47;color:#f3e3c2;padding:10px 20px;border-radius:24px;font-size:13px;font-weight:700;box-shadow:0 6px 20px rgba(0,0,0,.25);transition:opacity .3s;";
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 400); }, 3500);
}

async function loadDB() {
  let loaded = localLoad();
  if (cloudAvailable) {
    try {
      const snap = await getDoc(DOC_REF);
      if (snap.exists()) {
        const data = snap.data();
        db = Object.assign(JSON.parse(JSON.stringify(DEFAULT_DB)), data);
        db.settings = Object.assign({}, DEFAULT_DB.settings, data.settings || {});
        loaded = true;
      }
    } catch (e) {
      cloudAvailable = false;
      if (!cloudErrorShown) {
        cloudErrorShown = true;
        toast("⚠ تعذر الاتصال بقاعدة البيانات — هيشتغل وضع محلي مؤقت.");
      }
    }
  }
  if (!loaded) localSave();
}
async function saveDB() {
  localSave();
  if (!cloudAvailable) { showSave(false); return false; }
  try {
    await setDoc(DOC_REF, db);
    return true;
  } catch (e) {
    showSave(false, e && e.message);
    return false;
  }
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

  await loadDB();
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
  renderStudentStats();
  renderHomeLessons();
  renderHomeForum();
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
  saveDB();
  currentQuiz = null;
  renderQuizResult(sub, quiz);
  renderStudentStats();
}

function renderQuizResult(sub, quiz) {
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
    '<div>' + esc(msg) + '</div></div>' +
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
    saveDB();
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
  await loadDB();
  db.forum.push({
    id: uid("th"), title, body, author: me.name, code: me.code, grade: me.grade,
    createdAt: Date.now(), replies: []
  });
  await saveDB();
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

function renderTeacher() {
  $("teacherDbMode").textContent = cloudAvailable ? "متصل بالسحابة ✓" : "وضع محلي";
  const c = $("teacherContainer");
  c.innerHTML =
    '<div class="notice gold">📌 الأكواد دي هي اللي يتوزع على الطلاب — كل طالب بيكتب كوده في صفحة الدخول.</div>' +
    sectionCard("إحصائيات سريعة", teacherStatsHTML()) +
    sectionCard("الطلاب والأكواد", teacherStudentsHTML()) +
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
      if (rec) rec.present = present;
      else db.attendance.push({ id: uid("att"), date, code, present });
      await saveDB();
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
    '<div id="quizEditor"></div>';
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
    await saveDB();
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
  return '<div class="grid-2">' +
    '<div class="field"><label>كلمة سر اللوحة</label><input id="setPass" value="' + esc(db.settings.teacherPass) + '"></div>' +
    '<div class="field"><label>رقم واتساب المنصة (دولي بدون +)</label><input id="setWa" value="' + esc(db.settings.whatsapp || "") + '" placeholder="201012345678"></div>' +
    '</div>' +
    '<div class="field"><label>إعلان للطلاب (بيظهر في الرئيسية)</label><input id="setBanner" value="' + esc(db.settings.banner || "") + '" placeholder="مثال: امتحان الشهر الأسبوع الجاي — ذاكروا كويس!"></div>' +
    '<button class="btn primary" id="saveSettingsBtn">💾 حفظ الإعدادات</button>';
}

function bindTeacherEvents() {
  // طلاب
  $("addStudentBtn").addEventListener("click", async () => {
    const name = $("nsName").value.trim();
    const grade = $("nsGrade").value.trim() || "عام";
    const phone = $("nsPhone").value.trim();
    if (!name) { toast("اكتب اسم الطالب."); return; }
    await loadDB();
    const code = genCode(grade);
    db.students.push({ id: uid("st"), code, name, grade, phone });
    await saveDB();
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
      await loadDB();
      db.students = db.students.filter((s) => (s.id || s.code) !== key);
      await saveDB();
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

  // امتحانات
  $("createQuizBtn").addEventListener("click", async () => {
    const title = $("nqTitle").value.trim();
    if (!title) { toast("اكتب عنوان الامتحان."); return; }
    await loadDB();
    const q = {
      id: uid("qz"), title, desc: $("nqDesc").value.trim(), date: todayStr(),
      questions: [{ q: "السؤال الأول؟", choices: ["", "", "", ""], correct: 0 }]
    };
    db.quizzes.push(q);
    await saveDB();
    renderTeacher();
    openQuizEditor(q.id);
  });
  document.querySelectorAll("[data-edit-quiz]").forEach((b) => {
    b.addEventListener("click", () => openQuizEditor(b.dataset.editQuiz));
  });
  document.querySelectorAll("[data-del-quiz]").forEach((b) => {
    b.addEventListener("click", async () => {
      if (!confirm("حذف الامتحان وكل نتايجه؟")) return;
      await loadDB();
      const id = b.dataset.delQuiz;
      db.quizzes = db.quizzes.filter((x) => x.id !== id);
      db.submissions = db.submissions.filter((s) => s.quizId !== id);
      await saveDB();
      renderTeacher();
    });
  });

  // شروحات
  $("addLessonBtn").addEventListener("click", async () => {
    const title = $("nlTitle").value.trim();
    if (!title) { toast("اكتب عنوان الدرس."); return; }
    await loadDB();
    const videos = $("nlVideos").value.split("\n").map((s) => s.trim()).filter(Boolean);
    db.lessons.push({
      id: uid("ls"), title, desc: $("nlDesc").value.trim(),
      date: todayStr(), videos, body: $("nlBody").value.trim()
    });
    await saveDB();
    renderTeacher();
    toast("✓ تم إضافة الدرس");
  });
  document.querySelectorAll("[data-del-lesson]").forEach((b) => {
    b.addEventListener("click", async () => {
      if (!confirm("حذف الدرس؟")) return;
      await loadDB();
      db.lessons = db.lessons.filter((l) => l.id !== b.dataset.delLesson);
      await saveDB();
      renderTeacher();
    });
  });

  // منتدى
  document.querySelectorAll("[data-del-thread]").forEach((b) => {
    b.addEventListener("click", async () => {
      if (!confirm("حذف الموضوع وردوده؟")) return;
      await loadDB();
      db.forum = db.forum.filter((t) => t.id !== b.dataset.delThread);
      await saveDB();
      renderTeacher();
    });
  });

  // إعدادات
  $("saveSettingsBtn").addEventListener("click", async () => {
    await loadDB();
    db.settings.teacherPass = $("setPass").value || db.settings.teacherPass;
    db.settings.whatsapp = $("setWa").value.trim();
    db.settings.banner = $("setBanner").value.trim();
    await saveDB();
    toast("✓ تم حفظ الإعدادات");
  });

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
        db.settings = Object.assign({}, DEFAULT_DB.settings, imported.settings || {});
        await saveDB();
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
  if (resumeSession()) return;
  show("loginView");
}

boot();
