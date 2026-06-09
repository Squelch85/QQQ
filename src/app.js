import { Attempt, AttemptState } from "./attempt.js";
import { convertQuestionTable } from "./converter.js";
import { defaultExam } from "./default-exam.js";
import { getMaxScore, MAX_FILE_BYTES, parseExamJson, toPublicExam } from "./exam.js";
import { buildExamReport, createReportCsv, makeAttemptRecord, parseReportCsv } from "./report.js";
import { appendExamReportRecord, clearAllExamReportRecords, clearExamReportRecords, getReportStorageUsage, readExamReportCsv, readExamReportRecords } from "./report-storage.js";
import { loadReportDirectoryHandle, requestDirectoryPermission, saveReportDirectoryHandle, writeCandidateReport } from "./directory-report-storage.js";

const viewIds = ["load-view", "converter-view", "ready-view", "exam-view", "result-view", "report-view"];
const views = viewIds.map((id) => document.getElementById(id));
const fileInput = document.getElementById("exam-file");
const fileError = document.getElementById("file-error");
const timer = document.getElementById("timer");
const liveStatus = document.getElementById("live-status");
const submitDialog = document.getElementById("submit-dialog");
const reportStorage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();
let exam = null;
let publicExam = null;
let attempt = null;
let candidate = null;
let currentQuestionIndex = 0;
let timerId = null;
let deadline = null;
let reportMode = "latestPerEmployee";
let reportDirectoryHandle = null;

function showView(id) {
  for (const view of views) view.hidden = view.id !== id;
  window.scrollTo({ top: 0, behavior: "instant" });
}

function announce(message) {
  liveStatus.textContent = "";
  requestAnimationFrame(() => { liveStatus.textContent = message; });
}

function formatDuration(minutes) {
  return minutes === 0 ? "시간 제한 없음" : `${minutes}분`;
}

function stopTimer() {
  if (timerId) clearInterval(timerId);
  timerId = null;
  deadline = null;
  timer.hidden = true;
}

function prepareExam(nextExam) {
  stopTimer();
  exam = structuredClone(nextExam);
  publicExam = toPublicExam(exam);
  attempt = new Attempt(exam);
  document.getElementById("exam-title").textContent = publicExam.title;
  const passingScore = exam.passingScore ?? getMaxScore(exam) * 0.8;
  document.getElementById("exam-meta").textContent = `버전 ${publicExam.revision} · ${publicExam.questions.length}문항 · ${formatDuration(publicExam.durationMinutes)} · 합격 ${passingScore}점 이상`;
  document.getElementById("exam-instructions").textContent = publicExam.instructions || "별도 유의사항이 없습니다.";
  document.getElementById("candidate-form").reset();
  updateHistoryStorageSummary();
  showView("ready-view");
  document.getElementById("exam-title").focus({ preventScroll: true });
}

async function loadSelectedFile(file) {
  fileError.hidden = true;
  if (!file) return;
  try {
    if (file.size > MAX_FILE_BYTES) throw new Error(`시험지 파일은 ${MAX_FILE_BYTES / 1024 / 1024}MB 이하여야 합니다.`);
    prepareExam(parseExamJson(await file.text()));
  } catch (error) {
    fileError.textContent = error instanceof Error ? error.message : "시험지를 열 수 없습니다.";
    fileError.hidden = false;
    fileInput.value = "";
  }
}

function renderQuestionNavigation() {
  const list = document.getElementById("question-list");
  list.replaceChildren(...publicExam.questions.map((question, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const answered = attempt.isAnswered(question.id);
    button.type = "button";
    button.textContent = String(index + 1);
    button.classList.toggle("active", index === currentQuestionIndex);
    button.classList.toggle("answered", answered);
    button.setAttribute("aria-label", `${index + 1}번 문항${answered ? ", 응답 완료" : ", 미응답"}`);
    button.setAttribute("aria-current", index === currentQuestionIndex ? "step" : "false");
    button.addEventListener("click", () => renderQuestion(index));
    item.append(button);
    return item;
  }));
}

function buildChoice(question, choice, inputType, selected) {
  const label = document.createElement("label");
  label.className = "choice";
  const input = document.createElement("input");
  input.type = inputType;
  input.name = "answer";
  input.value = choice.id;
  input.checked = selected;
  input.addEventListener("change", () => {
    if (inputType === "radio") attempt.setAnswer(question.id, input.value);
    else {
      const selectedIds = [...document.querySelectorAll('#answer-form input[type="checkbox"]:checked')].map((element) => element.value);
      attempt.setAnswer(question.id, selectedIds);
    }
    updateProgress();
  });
  const text = document.createElement("span");
  text.textContent = choice.text;
  label.append(input, text);
  return label;
}

function renderQuestion(index, focus = true) {
  currentQuestionIndex = index;
  const question = publicExam.questions[index];
  const value = attempt.getAnswer(question.id);
  document.getElementById("question-number").textContent = `QUESTION ${String(index + 1).padStart(2, "0")}`;
  document.getElementById("question-score").textContent = `${question.score}점`;
  const heading = document.getElementById("question-heading");
  heading.textContent = question.prompt;
  const form = document.getElementById("answer-form");
  form.replaceChildren();
  if (question.type === "short_answer") {
    const label = document.createElement("label");
    label.className = "visually-hidden";
    label.htmlFor = "short-answer-input";
    label.textContent = "단답형 답안";
    const input = document.createElement("input");
    input.id = "short-answer-input";
    input.className = "short-answer";
    input.type = "text";
    input.value = value;
    input.placeholder = "답안을 입력하세요";
    input.maxLength = 10_000;
    input.addEventListener("input", () => { attempt.setAnswer(question.id, input.value); updateProgress(); });
    form.append(label, input);
  } else {
    const inputType = question.type === "single_choice" ? "radio" : "checkbox";
    for (const choice of question.choices) {
      const selected = Array.isArray(value) ? value.includes(choice.id) : value === choice.id;
      form.append(buildChoice(question, choice, inputType, selected));
    }
  }
  document.getElementById("previous-button").disabled = index === 0;
  document.getElementById("next-button").disabled = index === publicExam.questions.length - 1;
  renderQuestionNavigation();
  if (focus) heading.focus();
}

function updateProgress() {
  const answered = publicExam.questions.length - attempt.unansweredCount;
  document.getElementById("answered-count").textContent = String(answered);
  document.getElementById("question-count").textContent = String(publicExam.questions.length);
  document.getElementById("submit-summary").textContent = attempt.unansweredCount === 0 ? "모든 문항에 응답했습니다." : `미응답 ${attempt.unansweredCount}문항`;
  renderQuestionNavigation();
}

function startTimer() {
  if (publicExam.durationMinutes === 0) return;
  deadline = performance.now() + publicExam.durationMinutes * 60_000;
  timer.hidden = false;
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
    timer.textContent = `남은 시간 ${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
    if (remaining === 0) {
      clearInterval(timerId);
      announce("시험 시간이 만료되었습니다.");
      if (exam.expirationPolicy === "auto_submit") finalizeSubmission();
      else openSubmitDialog("시험 시간이 만료되었습니다. 현재 답안을 제출해 주세요.");
    }
  };
  tick();
  timerId = setInterval(tick, 250);
}

function openSubmitDialog(message) {
  document.getElementById("submit-dialog-copy").textContent = message ?? (attempt.unansweredCount === 0 ? "모든 문항에 응답했습니다." : `아직 답하지 않은 문항이 ${attempt.unansweredCount}개 있습니다.`);
  submitDialog.showModal();
}

function statusLabel(status) {
  return { correct: "정답", incorrect: "오답", unanswered: "미응답", review_required: "검토 필요" }[status];
}

function getStoredRecords() {
  return readExamReportRecords(reportStorage, exam);
}

function storeResult(result) {
  return appendExamReportRecord(reportStorage, exam, makeAttemptRecord(candidate, result, exam));
}

function renderReportData(report, target = "result") {
  const prefix = target === "result" ? "report" : "loaded-report";
  document.getElementById(`${prefix}-count`).textContent = `선택 ${report.examineeCount}건 · 전체 ${report.totalAttemptCount}건 · 고유 ${report.uniqueExamineeCount}명`;
  document.getElementById(`${prefix}-version`).textContent = `시험 ID ${report.examId} · 버전 ${report.examRevision}`;
  document.getElementById(`${prefix}-average`).textContent = `${report.averageScore}점`;
  document.getElementById(`${prefix}-pass-rate`).textContent = `${report.passRate}% (${report.passedCount}명)`;
  const summary = document.getElementById(`${prefix}-wrong-summary`);
  if (report.highWrongRate.length === 0) summary.textContent = "현재 오답이 집계된 문항이 없습니다.";
  else summary.replaceChildren(...report.highWrongRate.map((item) => {
    const card = document.createElement("div");
    const label = item.questionNumber ? `${item.questionNumber}번` : item.questionId;
    const name = document.createElement("span");
    name.textContent = label;
    name.title = item.prompt || item.questionId;
    const rate = document.createElement("strong");
    rate.textContent = `${item.wrongRate}%`;
    const count = document.createElement("small");
    count.textContent = `${item.wrongCount}/${item.attemptCount}명 오답`;
    card.append(name, rate, count);
    return card;
  }));
  document.getElementById(`${prefix}-body`).replaceChildren(...report.attempts.slice().reverse().map((record) => {
    const row = document.createElement("tr");
    const values = [new Date(record.submittedAt).toLocaleString("ko-KR"), record.candidate.name, record.candidate.employeeId, record.candidate.department || "-", `${record.score}/${record.maxScore}`, record.passed ? "합격" : "불합격"];
    for (const value of values) { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); }
    row.lastElementChild.className = record.passed ? "status-correct" : "status-incorrect";
    return row;
  }));
}

function renderReport(records) {
  const report = buildExamReport(exam, records, reportMode);
  renderReportData(report);
  return report;
}

function renderResult(result, records) {
  const passed = result.score >= (exam.passingScore ?? result.maxScore * 0.8);
  document.getElementById("candidate-result").textContent = `${candidate.name} · ${candidate.employeeId}${candidate.department ? ` · ${candidate.department}` : ""}`;
  document.getElementById("result-score").textContent = String(result.score);
  document.getElementById("result-max-score").textContent = `/ ${result.maxScore}점`;
  const badge = document.getElementById("pass-badge");
  badge.textContent = passed ? "합격" : "불합격";
  badge.className = passed ? "pass" : "fail";
  const items = result.items.map((item, index) => {
    const li = document.createElement("li");
    const top = document.createElement("div");
    top.className = "result-item-top";
    const title = document.createElement("strong");
    title.textContent = `${index + 1}. ${publicExam.questions[index].prompt}`;
    const status = document.createElement("span");
    status.className = `status-${item.status}`;
    status.textContent = `${statusLabel(item.status)} · ${item.earnedScore}/${item.maxScore}점`;
    top.append(title, status);
    li.append(top);
    return li;
  });
  document.getElementById("result-items").replaceChildren(...items);
  renderReport(records);
  showView("result-view");
  document.getElementById("result-title").focus({ preventScroll: true });
  announce(`채점 완료. ${result.maxScore}점 만점에 ${result.score}점, ${passed ? "합격" : "불합격"}입니다.`);
}

async function finalizeSubmission() {
  stopTimer();
  attempt.submit();
  const result = attempt.grade();
  const reportState = storeResult(result);
  const directoryState = await writeCandidateReport(reportDirectoryHandle, exam, reportState.records, candidate);
  const status = document.getElementById("report-storage-status");
  const browserStatus = reportState.stored
    ? `브라우저 저장 완료 · ${reportState.usage.recordCount}건 · ${formatBytes(reportState.usage.bytes)}`
    : "브라우저 저장소에 보관하지 못했습니다. 수동으로 CSV를 저장하세요.";
  if (directoryState.saved) status.textContent = `${browserStatus} · ${directoryState.filename} 자동 저장 (${directoryState.recordCount}건)`;
  else if (directoryState.reason === "permission_required") status.textContent = `${browserStatus} · 자동 저장 권한이 필요합니다. 시험 준비 화면에서 디렉터리를 다시 선택하세요.`;
  else if (directoryState.reason === "write_failed") status.textContent = `${browserStatus} · 응시자별 CSV 자동 저장에 실패했습니다.`;
  else if (reportState.usage.warning) status.textContent = `${browserStatus} · CSV 백업 후 이전 기록 정리를 권장합니다.`;
  else status.textContent = `${browserStatus} · 자동 저장 디렉터리가 지정되지 않았습니다.`;
  renderResult(result, reportState.records);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function updateHistoryStorageSummary() {
  const summary = document.getElementById("history-storage-summary");
  if (!summary || !exam) return;
  const records = getStoredRecords();
  const csv = readExamReportCsv(reportStorage, exam) || (records.length ? createReportCsv(exam, records) : "");
  const usage = getReportStorageUsage(csv, records.length);
  summary.textContent = `${exam.title} · 버전 ${exam.revision} · ${records.length}건 · ${formatBytes(usage.bytes)}`;
  document.getElementById("backup-clear-button").disabled = records.length === 0;
}

function backupAndClearCurrentHistory() {
  const records = getStoredRecords();
  if (records.length === 0) return;
  downloadReport();
  const message = `${exam.title} (ID: ${exam.id}, 버전: ${exam.revision})의 응시 기록 ${records.length}건을 삭제합니다. CSV 다운로드가 시작되었는지 확인하세요. 삭제 후 복구할 수 없습니다.`;
  if (!window.confirm(message)) return;
  const cleared = clearExamReportRecords(reportStorage, exam.id, exam.revision);
  announce(cleared ? "현재 시험 기록을 삭제했습니다." : "시험 기록을 삭제하지 못했습니다.");
  updateHistoryStorageSummary();
}

function clearAllHistory() {
  if (!window.confirm("이 브라우저의 모든 시험 버전 기록을 삭제합니다. 개별 CSV로 백업하지 않은 기록은 복구할 수 없습니다.")) return;
  const result = clearAllExamReportRecords(reportStorage);
  announce(result.cleared ? `시험 기록 저장 키 ${result.count}개를 삭제했습니다.` : "전체 시험 기록을 삭제하지 못했습니다.");
  updateHistoryStorageSummary();
}

function downloadJson(data, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
}

function downloadReport(csv = readExamReportCsv(reportStorage, exam) || createReportCsv(exam, getStoredRecords())) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${exam.id}-report.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function navigateHome() {
  fileInput.value = "";
  const resumeButton = document.getElementById("resume-exam-button");
  resumeButton.hidden = !exam;
  if (exam) resumeButton.firstChild.textContent = attempt?.state === AttemptState.IN_PROGRESS ? "진행 중인 시험 계속 " : "현재 시험 계속 ";
  showView("load-view");
}

function resumeExam() {
  if (!exam || !attempt) return;
  if (attempt.state === AttemptState.READY) showView("ready-view");
  else if (attempt.state === AttemptState.IN_PROGRESS) {
    showView("exam-view");
    renderQuestion(currentQuestionIndex);
    updateProgress();
  } else showView("result-view");
}

function startNewAttempt() {
  stopTimer();
  attempt = new Attempt(exam);
  candidate = null;
  currentQuestionIndex = 0;
  document.getElementById("candidate-form").reset();
  updateHistoryStorageSummary();
  showView("ready-view");
  document.getElementById("exam-title").focus({ preventScroll: true });
}

function updateDirectoryStorageStatus(message) {
  const status = document.getElementById("directory-storage-status");
  if (message) status.textContent = message;
  else if (reportDirectoryHandle) status.textContent = `자동 저장 디렉터리: ${reportDirectoryHandle.name}`;
  else if (typeof window.showDirectoryPicker !== "function") status.textContent = "이 브라우저는 디렉터리 자동 저장을 지원하지 않습니다. 수동 CSV 저장을 사용하세요.";
  else status.textContent = "자동 저장 디렉터리를 선택하면 응시자별 CSV를 저장 창 없이 갱신합니다.";
}

async function selectReportDirectory() {
  if (typeof window.showDirectoryPicker !== "function") {
    updateDirectoryStorageStatus();
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ id: "candidate-reports", mode: "readwrite" });
    if (await requestDirectoryPermission(handle) !== "granted") {
      updateDirectoryStorageStatus("선택한 디렉터리의 쓰기 권한이 승인되지 않았습니다.");
      return;
    }
    reportDirectoryHandle = handle;
    try {
      await saveReportDirectoryHandle(handle);
      updateDirectoryStorageStatus();
    } catch {
      updateDirectoryStorageStatus(`자동 저장 디렉터리: ${handle.name} (현재 실행 중에만 유지)`);
    }
  } catch (error) {
    if (error?.name !== "AbortError") updateDirectoryStorageStatus("자동 저장 디렉터리를 선택하지 못했습니다.");
  }
}

async function restoreReportDirectory() {
  try {
    reportDirectoryHandle = await loadReportDirectoryHandle();
  } catch {
    reportDirectoryHandle = null;
  }
  updateDirectoryStorageStatus();
}

fileInput.addEventListener("change", () => loadSelectedFile(fileInput.files[0]));
document.getElementById("report-file").addEventListener("change", async (event) => {
  const input = event.currentTarget;
  const errorBox = document.getElementById("report-file-error");
  const file = input.files[0];
  if (!file) return;
  try {
    if (file.size > MAX_FILE_BYTES) throw new Error(`리포트 파일은 ${MAX_FILE_BYTES / 1024 / 1024}MB 이하여야 합니다.`);
    const report = parseReportCsv(await file.text());
    document.getElementById("loaded-report-title").textContent = report.examTitle;
    document.getElementById("loaded-report-generated-at").textContent = report.generatedAt
      ? `생성일시 ${new Date(report.generatedAt).toLocaleString("ko-KR")}`
      : "";
    renderReportData(report, "loaded");
    errorBox.hidden = true;
    showView("report-view");
    document.getElementById("loaded-report-title").focus({ preventScroll: true });
  } catch (error) {
    errorBox.textContent = error instanceof Error ? error.message : "리포트를 열 수 없습니다.";
    errorBox.hidden = false;
    input.value = "";
  }
});

document.getElementById("home-link").addEventListener("click", (event) => { event.preventDefault(); navigateHome(); });
document.getElementById("resume-exam-button").addEventListener("click", resumeExam);
document.getElementById("default-exam-button").addEventListener("click", () => prepareExam(defaultExam));
document.getElementById("show-converter-button").addEventListener("click", () => { showView("converter-view"); document.getElementById("converter-title").focus(); });
document.getElementById("convert-button").addEventListener("click", () => {
  const errorBox = document.getElementById("converter-error");
  try {
    const converted = convertQuestionTable(document.getElementById("converter-source").value, {
      title: document.getElementById("converter-exam-title").value,
      durationMinutes: document.getElementById("converter-duration").value,
      passingScore: document.getElementById("converter-passing-score").value,
      questionCount: document.getElementById("converter-question-count").value
    });
    parseExamJson(JSON.stringify(converted));
    errorBox.hidden = true;
    downloadJson(converted, "converted-exam.json");
  } catch (error) {
    errorBox.textContent = error instanceof Error ? error.message : "문항을 변환할 수 없습니다.";
    errorBox.hidden = false;
  }
});
document.getElementById("candidate-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  candidate = Object.fromEntries(formData);
  attempt.start(); showView("exam-view"); renderQuestion(0); updateProgress(); startTimer();
});
document.getElementById("previous-button").addEventListener("click", () => renderQuestion(currentQuestionIndex - 1));
document.getElementById("next-button").addEventListener("click", () => renderQuestion(currentQuestionIndex + 1));
document.getElementById("submit-button").addEventListener("click", () => openSubmitDialog());
document.getElementById("confirm-submit").addEventListener("click", () => { void finalizeSubmission(); });
document.getElementById("download-button").addEventListener("click", () => downloadReport());
document.getElementById("report-mode").addEventListener("change", (event) => { reportMode = event.currentTarget.value; renderReport(getStoredRecords()); });
document.getElementById("backup-clear-button").addEventListener("click", backupAndClearCurrentHistory);
document.getElementById("clear-all-button").addEventListener("click", clearAllHistory);
document.getElementById("print-button").addEventListener("click", () => window.print());
document.getElementById("select-directory-button").addEventListener("click", () => { void selectReportDirectory(); });
document.getElementById("new-attempt-button").addEventListener("click", startNewAttempt);
for (const button of document.querySelectorAll(".home-button")) button.addEventListener("click", navigateHome);
void restoreReportDirectory();
