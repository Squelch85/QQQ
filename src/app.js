import { Attempt, AttemptState } from "./attempt.js";
import { convertQuestionTable } from "./converter.js";
import { defaultExam } from "./default-exam.js";
import { getMaxScore, MAX_FILE_BYTES, parseExamJson, toPublicExam } from "./exam.js";
import { buildExamReport, createReportCsv, makeAttemptRecord, parseReportCsv } from "./report.js";
import { createCertificatePng } from "./certificate.js";
import { certificateImageUrl, certificateViewModel } from "./certificate-ui.js";
import { cancelCertificate, exportResultsCsvUrl, saveExamResult, searchResults, uploadCertificate, verifyCertificate, markCertificateIssueFailed } from "./result-api.js";

const viewIds = ["load-view", "converter-view", "ready-view", "exam-view", "result-view", "report-view", "verify-view", "admin-view"];
const views = viewIds.map((id) => document.getElementById(id));
const fileInput = document.getElementById("exam-file");
const fileError = document.getElementById("file-error");
const timer = document.getElementById("timer");
const liveStatus = document.getElementById("live-status");
const submitDialog = document.getElementById("submit-dialog");
let exam = null;
let publicExam = null;
let attempt = null;
let candidate = null;
let currentQuestionIndex = 0;
let timerId = null;
let deadline = null;
let reportMode = "latestPerEmployee";
let runtimeRecords = [];
let lastCertificateResult = null;
let certificatePreviewUrl = null;
let certificateBlob = null;
let adminCertificatePreviewUrl = null;

function revokePreviewUrl(name) {
  const url = name === "admin" ? adminCertificatePreviewUrl : certificatePreviewUrl;
  if (url) URL.revokeObjectURL(url);
  if (name === "admin") adminCertificatePreviewUrl = null;
  else certificatePreviewUrl = null;
}

function clearCertificatePreview() {
  revokePreviewUrl("result");
  certificateBlob = null;
  const image = document.getElementById("certificate-preview");
  image.removeAttribute("src");
  image.alt = "";
}

function showCertificatePreview(result, blob) {
  clearCertificatePreview();
  certificateBlob = blob;
  certificatePreviewUrl = URL.createObjectURL(blob);
  result.previewUrl = certificatePreviewUrl;
  const image = document.getElementById("certificate-preview");
  image.src = certificatePreviewUrl;
  image.alt = `인증 ID ${result.cert_id} 인증서 미리보기`;
}

function renderCertificateState(result = {}) {
  const model = certificateViewModel(result);
  const badge = document.getElementById("certificate-status-badge");
  badge.textContent = model.label;
  badge.className = `certificate-badge ${model.status.toLowerCase().replaceAll("_", "-")}`;
  document.getElementById("certificate-status-message").textContent = model.message;
  const frame = document.getElementById("certificate-preview-frame");
  frame.hidden = !model.showPreview;
  frame.classList.toggle("loading", model.loading);
  document.getElementById("certificate-cancelled-overlay").hidden = !model.cancelled;
  document.getElementById("certificate-details").hidden = !model.showDetails;
  document.getElementById("certificate-actions").hidden = !model.showActions;
  document.getElementById("certificate-id").textContent = result.cert_id || "-";
  document.getElementById("certificate-status").textContent = model.label;
  document.getElementById("certificate-path").textContent = result.certificate_path || "-";
  document.getElementById("certificate-hash").textContent = result.certificate_hash || "-";
  document.getElementById("certificate-issued-date").textContent = result.issued_date || "-";
  document.getElementById("certificate-validity").textContent = result.valid_from && result.valid_to ? `${result.valid_from} ~ ${result.valid_to}` : "-";
  if (model.showPreview && !certificatePreviewUrl && result.certificate_path) {
    const image = document.getElementById("certificate-preview");
    image.src = certificateImageUrl(result.certificate_path);
    image.alt = `인증 ID ${result.cert_id} 인증서 미리보기`;
  }
}

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
  clearCertificatePreview();
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
  return runtimeRecords;
}

function storeResult(result) {
  const record = makeAttemptRecord(candidate, result, exam);
  runtimeRecords.push(record);
  return record;
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
  storeResult(result);
  const status = document.getElementById("report-storage-status");
  clearCertificatePreview();
  renderCertificateState({ cert_status: "ISSUE_PENDING" });
  try {
    let saved = await saveExamResult(candidate, result, exam);
    status.textContent = `SQLite DB 저장 완료 · 결과 번호 ${saved.result_id}`;
    lastCertificateResult = null;
    if (saved.cert_id) {
      lastCertificateResult = saved;
      renderCertificateState(saved);
      try {
        const verificationUrl = new URL(`/api/certificates/${encodeURIComponent(saved.cert_id)}`, window.location.origin).href;
        const png = await createCertificatePng(saved, verificationUrl);
        showCertificatePreview(saved, png);
        saved = await uploadCertificate(saved.cert_id, png);
        saved.previewUrl = certificatePreviewUrl;
        lastCertificateResult = saved;
        renderCertificateState(saved);
        status.textContent += ` · 인증서 자동 발행 완료 (${saved.cert_id})`;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "인증서 생성 실패";
        await markCertificateIssueFailed(saved.cert_id, reason);
        clearCertificatePreview();
        lastCertificateResult = { ...saved, cert_status: "ISSUE_FAILED", issue_error: reason };
        renderCertificateState(lastCertificateResult);
        status.textContent += ` · 인증서 생성 실패 (DB 결과는 보존됨, ${saved.cert_id})`;
      }
    } else {
      lastCertificateResult = { ...saved, cert_status: "NOT_ELIGIBLE" };
      renderCertificateState(lastCertificateResult);
      status.textContent += " · 인증서 발행 기준 미충족";
    }
  } catch (error) {
    lastCertificateResult = { cert_status: "DB_SAVE_FAILED", issue_error: error instanceof Error ? error.message : "" };
    renderCertificateState(lastCertificateResult);
    status.textContent = error instanceof Error ? `DB 저장 실패: ${error.message}` : "DB 저장에 실패했습니다.";
  }
  renderResult(result, runtimeRecords);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function updateHistoryStorageSummary() {
  const summary = document.getElementById("history-storage-summary");
  if (!summary || !exam) return;
  summary.textContent = `${exam.title} · 버전 ${exam.revision} · 제출 결과는 SQLite DB에 원본 저장됩니다.`;
}

function downloadJson(data, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
}

function downloadReport(csv = createReportCsv(exam, getStoredRecords())) {
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
  clearCertificatePreview();
  attempt = new Attempt(exam);
  candidate = null;
  currentQuestionIndex = 0;
  document.getElementById("candidate-form").reset();
  updateHistoryStorageSummary();
  showView("ready-view");
  document.getElementById("exam-title").focus({ preventScroll: true });
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
document.getElementById("print-button").addEventListener("click", () => window.print());
document.getElementById("new-attempt-button").addEventListener("click", startNewAttempt);
document.getElementById("certificate-open-button").addEventListener("click", () => {
  const url = certificatePreviewUrl || certificateImageUrl(lastCertificateResult?.certificate_path);
  if (url) window.open(url, "_blank", "noopener");
});
document.getElementById("certificate-download-button").addEventListener("click", () => {
  const url = certificatePreviewUrl || certificateImageUrl(lastCertificateResult?.certificate_path);
  if (!url) return;
  const link = document.createElement("a");
  link.href = url;
  link.download = `CERT_${lastCertificateResult.cert_id}.png`;
  link.click();
});
document.getElementById("show-verify-button").addEventListener("click", () => showView("verify-view"));
document.getElementById("show-admin-button").addEventListener("click", () => { showView("admin-view"); void loadAdminResults(); });
document.getElementById("verify-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const output = document.getElementById("verify-result");
  try {
    const value = await verifyCertificate(document.getElementById("verify-cert-id").value.trim());
    output.textContent = [
      `인증 상태: ${{ VALID: "유효", EXPIRED: "만료", CANCELLED: "취소", ISSUE_FAILED: "발행 실패", ISSUE_PENDING: "발행 중" }[value.cert_status] || value.cert_status}`,
      `성명: ${value.employee_name}`, `사번: ${value.employee_id}`, `부서: ${value.department || "-"}`,
      `평가명: ${value.exam_name}`, `평가일자: ${value.exam_date}`, `점수: ${value.score}`,
      `판정: ${value.pass_status}`, `등급: ${value.grade}`, `유효기간: ${value.valid_from || "-"} ~ ${value.valid_to || "-"}`,
      `인증서 경로: ${value.certificate_path || "-"}`, `SHA-256: ${value.certificate_hash || "-"}`
    ].join("\n");
  } catch (error) {
    output.textContent = error instanceof Error ? error.message : "조회하지 못했습니다.";
  }
});

function adminFilters() {
  return Object.fromEntries(new FormData(document.getElementById("admin-search-form")));
}

async function loadAdminResults() {
  const body = document.getElementById("admin-results-body");
  try {
    const results = await searchResults(adminFilters());
    body.replaceChildren(...results.map((record) => {
      const row = document.createElement("tr");
      [record.exam_date, record.employee_name, record.employee_id, record.cert_id || "-", record.score, record.grade, record.pass_status, record.cert_status || "-"].forEach((value) => {
        const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
      });
      const action = document.createElement("td");
      if (record.cert_id) {
        const reissue = document.createElement("button");
        reissue.type = "button"; reissue.textContent = "재발행";
        reissue.addEventListener("click", async () => {
          const panel = document.getElementById("admin-certificate-preview-panel");
          const message = document.getElementById("admin-certificate-message");
          message.textContent = "인증서 재발행 중입니다.";
          try {
            const originalCertId = record.cert_id;
            const url = new URL(`/api/certificates/${encodeURIComponent(originalCertId)}`, window.location.origin).href;
            const png = await createCertificatePng(record, url);
            const saved = await uploadCertificate(originalCertId, png);
            if (saved.cert_id !== originalCertId) throw new Error("재발행 중 인증 ID가 변경되었습니다.");
            revokePreviewUrl("admin");
            adminCertificatePreviewUrl = URL.createObjectURL(png);
            const image = document.getElementById("admin-certificate-preview");
            image.src = adminCertificatePreviewUrl;
            image.alt = `인증 ID ${saved.cert_id} 재발행 인증서 미리보기`;
            document.getElementById("admin-certificate-id").textContent = saved.cert_id;
            document.getElementById("admin-certificate-status").textContent = certificateViewModel(saved).label;
            document.getElementById("admin-certificate-hash").textContent = saved.certificate_hash || "-";
            document.getElementById("admin-certificate-path").textContent = saved.certificate_path || "-";
            document.getElementById("admin-certificate-reissued-at").textContent = new Date().toLocaleString("ko-KR");
            const badge = document.getElementById("admin-certificate-status-badge");
            badge.textContent = certificateViewModel(saved).label;
            badge.className = `certificate-badge ${saved.cert_status.toLowerCase().replaceAll("_", "-")}`;
            document.getElementById("admin-certificate-cancelled-overlay").hidden = saved.cert_status !== "CANCELLED";
            message.textContent = saved.cert_status === "CANCELLED"
              ? "이미지를 재발행했지만 취소 상태는 유지됩니다."
              : "인증서 이미지 재발행이 완료되었습니다.";
            panel.hidden = false;
            document.getElementById("admin-certificate-preview-title").focus({ preventScroll: true });
            await loadAdminResults();
          } catch (error) {
            message.textContent = error instanceof Error ? `재발행 실패: ${error.message}` : "인증서 재발행에 실패했습니다.";
            panel.hidden = false;
          }
        });
        const cancel = document.createElement("button");
        cancel.type = "button"; cancel.textContent = "취소";
        cancel.addEventListener("click", async () => {
          if (!window.confirm(`${record.cert_id} 인증을 취소할까요?`)) return;
          await cancelCertificate(record.cert_id, "관리자 화면에서 취소");
          await loadAdminResults();
        });
        action.append(reissue, cancel);
      }
      row.append(action);
      return row;
    }));
  } catch (error) {
    body.replaceChildren();
    announce(error instanceof Error ? error.message : "관리 결과를 조회하지 못했습니다.");
  }
}
document.getElementById("admin-search-form").addEventListener("submit", (event) => { event.preventDefault(); void loadAdminResults(); });
document.getElementById("admin-export-button").addEventListener("click", () => { window.location.href = exportResultsCsvUrl(adminFilters()); });
for (const button of document.querySelectorAll(".home-button")) button.addEventListener("click", navigateHome);
