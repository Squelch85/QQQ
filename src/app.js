import { Attempt } from "./attempt.js";
import { MAX_FILE_BYTES, parseExamJson, toPublicExam } from "./exam.js";

const views = ["load-view", "ready-view", "exam-view", "result-view"].map((id) => document.getElementById(id));
const fileInput = document.getElementById("exam-file");
const fileError = document.getElementById("file-error");
const timer = document.getElementById("timer");
const liveStatus = document.getElementById("live-status");
const submitDialog = document.getElementById("submit-dialog");
let exam = null;
let publicExam = null;
let attempt = null;
let currentQuestionIndex = 0;
let timerId = null;
let deadline = null;

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

async function loadSelectedFile(file) {
  fileError.hidden = true;
  if (!file) return;
  try {
    if (file.size > MAX_FILE_BYTES) throw new Error(`시험지 파일은 ${MAX_FILE_BYTES / 1024 / 1024}MB 이하여야 합니다.`);
    exam = parseExamJson(await file.text());
    publicExam = toPublicExam(exam);
    attempt = new Attempt(exam);
    document.getElementById("exam-title").textContent = publicExam.title;
    document.getElementById("exam-meta").textContent = `${publicExam.questions.length}문항 · ${formatDuration(publicExam.durationMinutes)}`;
    document.getElementById("exam-instructions").textContent = publicExam.instructions || "별도 유의사항이 없습니다.";
    showView("ready-view");
    document.getElementById("exam-title").focus({ preventScroll: true });
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
    button.type = "button";
    button.textContent = String(index + 1);
    button.classList.toggle("active", index === currentQuestionIndex);
    button.classList.toggle("answered", attempt.isAnswered(question.id));
    button.setAttribute("aria-label", `${index + 1}번 문항${attempt.isAnswered(question.id) ? ", 응답 완료" : ", 미응답"}`);
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
    input.addEventListener("input", () => {
      attempt.setAnswer(question.id, input.value);
      updateProgress();
    });
    form.append(label, input);
  } else {
    const inputType = question.type === "single_choice" ? "radio" : "checkbox";
    for (const choice of question.choices) {
      const selected = Array.isArray(value) ? value.includes(choice.id) : value === choice.id;
      form.append(buildChoice(question, choice, inputType, selected));
    }
  }

  document.getElementById("previous-button").disabled = index === 0;
  const next = document.getElementById("next-button");
  next.disabled = index === publicExam.questions.length - 1;
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
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    timer.textContent = `남은 시간 ${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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
  document.getElementById("submit-dialog-copy").textContent = message ?? (attempt.unansweredCount === 0
    ? "모든 문항에 응답했습니다."
    : `아직 답하지 않은 문항이 ${attempt.unansweredCount}개 있습니다.`);
  submitDialog.showModal();
}

function statusLabel(status) {
  return { correct: "정답", incorrect: "오답", unanswered: "미응답", review_required: "검토 필요" }[status];
}

function renderResult(result) {
  document.getElementById("result-score").textContent = String(result.score);
  document.getElementById("result-max-score").textContent = `/ ${result.maxScore}점`;
  const items = result.items.map((item, index) => {
    const question = publicExam.questions[index];
    const li = document.createElement("li");
    const top = document.createElement("div");
    top.className = "result-item-top";
    const title = document.createElement("strong");
    title.textContent = `${index + 1}. ${question.prompt}`;
    const status = document.createElement("span");
    status.className = `status-${item.status}`;
    status.textContent = `${statusLabel(item.status)} · ${item.earnedScore}/${item.maxScore}점`;
    top.append(title, status);
    li.append(top);
    if (item.explanation) {
      const explanation = document.createElement("p");
      explanation.className = "explanation";
      explanation.textContent = `해설: ${item.explanation}`;
      li.append(explanation);
    }
    return li;
  });
  document.getElementById("result-items").replaceChildren(...items);
  showView("result-view");
  document.getElementById("result-title").focus({ preventScroll: true });
  announce(`채점 완료. ${result.maxScore}점 만점에 ${result.score}점입니다.`);
}

function finalizeSubmission() {
  if (timerId) clearInterval(timerId);
  timer.hidden = true;
  attempt.submit();
  renderResult(attempt.grade());
}

function downloadResult() {
  const result = attempt.result;
  const exportData = {
    schemaVersion: 1,
    examId: result.examId,
    examTitle: publicExam.title,
    submittedAt: result.submittedAt,
    score: result.score,
    maxScore: result.maxScore,
    items: result.items.map(({ questionId, status, earnedScore, maxScore }) => ({ questionId, status, earnedScore, maxScore }))
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${exam.id}-result.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function reset() {
  if (timerId) clearInterval(timerId);
  exam = null;
  publicExam = null;
  attempt = null;
  fileInput.value = "";
  timer.hidden = true;
  showView("load-view");
  fileInput.focus();
}

fileInput.addEventListener("change", () => loadSelectedFile(fileInput.files[0]));
document.getElementById("start-button").addEventListener("click", () => {
  attempt.start();
  showView("exam-view");
  renderQuestion(0);
  updateProgress();
  startTimer();
});
document.getElementById("previous-button").addEventListener("click", () => renderQuestion(currentQuestionIndex - 1));
document.getElementById("next-button").addEventListener("click", () => renderQuestion(currentQuestionIndex + 1));
document.getElementById("submit-button").addEventListener("click", () => openSubmitDialog());
document.getElementById("confirm-submit").addEventListener("click", finalizeSubmission);
document.getElementById("download-button").addEventListener("click", downloadResult);
document.getElementById("print-button").addEventListener("click", () => window.print());
for (const button of document.querySelectorAll(".reset-button")) button.addEventListener("click", reset);
