import { createReportCsv } from "./report.js";

const DATABASE_NAME = "qqq-exam-settings";
const DATABASE_VERSION = 1;
const STORE_NAME = "file-handles";
const DIRECTORY_HANDLE_KEY = "candidate-report-directory";

function openDatabase(indexedDb) {
  return new Promise((resolve, reject) => {
    if (!indexedDb) {
      reject(new Error("IndexedDB를 사용할 수 없습니다."));
      return;
    }
    const request = indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("디렉터리 설정을 열 수 없습니다.")));
  });
}

function runTransaction(indexedDb, mode, operation) {
  return openDatabase(indexedDb).then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    request.addEventListener("success", () => resolve(request.result ?? null));
    request.addEventListener("error", () => reject(request.error ?? new Error("디렉터리 설정을 저장할 수 없습니다.")));
    transaction.addEventListener("complete", () => database.close());
    transaction.addEventListener("abort", () => database.close());
  }));
}

export function loadReportDirectoryHandle(indexedDb = globalThis.indexedDB) {
  return runTransaction(indexedDb, "readonly", (store) => store.get(DIRECTORY_HANDLE_KEY));
}

export function saveReportDirectoryHandle(handle, indexedDb = globalThis.indexedDB) {
  return runTransaction(indexedDb, "readwrite", (store) => store.put(handle, DIRECTORY_HANDLE_KEY));
}

export function sanitizeFilenamePart(value, fallback = "unknown") {
  const sanitized = String(value ?? "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return (sanitized || fallback).slice(0, 80);
}

export function getCandidateReportFilename(exam, candidate) {
  const employeeId = sanitizeFilenamePart(candidate.employeeId, "no-id");
  const name = sanitizeFilenamePart(candidate.name, "no-name");
  const examId = sanitizeFilenamePart(exam.id, "exam");
  return `${employeeId}_${name}__${examId}_v${exam.revision ?? 1}.csv`;
}

export function selectCandidateRecords(records, candidate) {
  const employeeId = String(candidate.employeeId ?? "");
  return records.filter((record) => String(record.candidate?.employeeId ?? "") === employeeId);
}

export async function getDirectoryPermission(handle) {
  if (!handle?.queryPermission) return "denied";
  try {
    return await handle.queryPermission({ mode: "readwrite" });
  } catch {
    return "denied";
  }
}

export async function requestDirectoryPermission(handle) {
  const current = await getDirectoryPermission(handle);
  if (current === "granted" || !handle?.requestPermission) return current;
  try {
    return await handle.requestPermission({ mode: "readwrite" });
  } catch {
    return "denied";
  }
}

export async function writeCandidateReport(handle, exam, records, candidate, generatedAt) {
  if (!handle) return { saved: false, reason: "directory_not_selected" };
  if (await getDirectoryPermission(handle) !== "granted") return { saved: false, reason: "permission_required" };

  const candidateRecords = selectCandidateRecords(records, candidate);
  const filename = getCandidateReportFilename(exam, candidate);
  try {
    const fileHandle = await handle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(createReportCsv(exam, candidateRecords, generatedAt));
    await writable.close();
    return { saved: true, filename, recordCount: candidateRecords.length };
  } catch (error) {
    return { saved: false, reason: "write_failed", error };
  }
}
