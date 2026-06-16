import { createReportCsv } from "./report.js";

async function request(path, options) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "DB 서버 요청에 실패했습니다.");
  return payload;
}

export function makeResultPayload(candidate, result, exam, submission = null) {
  const correctCount = result.items.filter((item) => item.status === "correct").length;
  const examDate = result.submittedAt;
  const issuedDate = examDate.slice(0, 10);
  const validTo = new Date(examDate);
  validTo.setUTCFullYear(validTo.getUTCFullYear() + Number(exam.certificateValidityYears ?? 1));
  return {
    exam_type: exam.examType || "GRR-WT",
    exam_name: exam.certificateExamName || exam.title,
    exam_version: String(exam.revision ?? 1),
    exam_id: exam.id,
    exam_revision: exam.revision ?? 1,
    employee_id: candidate.employeeId,
    employee_name: candidate.name,
    department: candidate.department || "",
    process_name: candidate.processName || "",
    exam_date: examDate,
    submitted_at: submission?.submittedAt ?? examDate,
    answers: submission?.answers ?? {},
    items: result.items,
    total_questions: result.items.length,
    correct_count: correctCount,
    wrong_count: result.items.length - correctCount,
    score: result.score,
    max_score: result.maxScore,
    pass_score: exam.passingScore ?? result.maxScore * 0.8,
    issued_date: issuedDate,
    valid_from: issuedDate,
    valid_to: validTo.toISOString().slice(0, 10),
    evaluator: candidate.evaluator || "",
    approver: candidate.approver || ""
  };
}

export function makeLocalCertificateResult(candidate, result, exam) {
  const payload = makeResultPayload(candidate, result, exam);
  const grade = result.score >= 90 ? "A" : result.score >= 80 ? "B" : result.score >= 70 ? "C" : "D";
  const passed = result.score >= payload.pass_score;
  if (!passed || result.score < 80) return { ...payload, grade, pass_status: passed ? "PASS" : "FAIL", cert_status: "NOT_ELIGIBLE" };

  const randomId = globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 12).toUpperCase()
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
  return {
    ...payload,
    grade,
    pass_status: "PASS",
    cert_id: `LOCAL-${payload.issued_date.replaceAll("-", "")}-${randomId}`,
    cert_status: "LOCAL_ONLY",
    qr_value: null
  };
}

export async function saveExamResult(candidate, result, exam, submission = null) {
  return (await request("/api/results", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(makeResultPayload(candidate, result, exam, submission))
  })).result;
}

export async function createAssessmentSession(payload) {
  return (await request("/api/assessment-sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  })).session;
}

export async function saveSubmission(payload) {
  return request("/api/submissions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function validateCertificationReadiness(sessionId, qualificationTypeId = null, examineeId = null) {
  const body = {
    assessment_session_id: sessionId,
    qualification_type_id: qualificationTypeId,
    examinee_id: examineeId
  };
  return (await request("/api/certification/readiness", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(Object.fromEntries(Object.entries(body).filter(([, value]) => value !== null && value !== undefined && value !== "")))
  })).readiness;
}

export async function createCertificationDecision(payload) {
  return request("/api/certification-decisions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function uploadCertificate(certId, blob) {
  return (await request(`/api/certificates/${encodeURIComponent(certId)}/image`, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: blob
  })).result;
}

export async function markCertificateIssueFailed(certId, reason) {
  await request(`/api/certificates/${encodeURIComponent(certId)}/issue-failed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason })
  });
}

export async function verifyCertificate(certId) {
  return (await request(`/api/certificates/${encodeURIComponent(certId)}`)).result;
}

export async function searchResults(parameters = {}) {
  const query = new URLSearchParams(Object.entries(parameters).filter(([, value]) => value));
  return (await request(`/api/results?${query}`)).results;
}

export async function cancelCertificate(certId, reason) {
  return (await request(`/api/certificates/${encodeURIComponent(certId)}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason })
  })).result;
}

export function exportResultsCsvUrl(parameters = {}) {
  const query = new URLSearchParams(Object.entries(parameters).filter(([, value]) => value));
  return `/api/results.csv?${query}`;
}

// 기존 CSV 포맷이 필요한 관리용 선택 내보내기에서만 사용한다.
export function createLegacyReportExport(exam, records) {
  return createReportCsv(exam, records);
}
