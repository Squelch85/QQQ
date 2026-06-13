import test from "node:test";
import assert from "node:assert/strict";
import { certificateImageUrl, certificateViewModel } from "../src/certificate-ui.js";

test("VALID 상태는 이미지와 상세 정보 및 동작을 표시한다", () => {
  const model = certificateViewModel({
    cert_status: "VALID",
    cert_id: "CERT-1",
    certificate_path: "certificates/2026/CERT_CERT-1.png"
  });

  assert.equal(model.showPreview, true);
  assert.equal(model.showDetails, true);
  assert.equal(model.showActions, true);
  assert.equal(certificateImageUrl("certificates/2026/file.png"), "/certificates/2026/file.png");
});

test("C/D 등급 미발행 상태는 미리보기와 다운로드를 숨긴다", () => {
  const model = certificateViewModel({ cert_status: "NOT_ELIGIBLE", grade: "C" });

  assert.equal(model.showPreview, false);
  assert.equal(model.showActions, false);
  assert.match(model.message, /발행 기준을 충족하지 못했습니다/);
});

test("ISSUE_FAILED는 DB 보존 및 이미지 생성 실패를 안내한다", () => {
  const model = certificateViewModel({
    cert_status: "ISSUE_FAILED",
    cert_id: "CERT-2",
    issue_error: "canvas 오류"
  });

  assert.equal(model.showPreview, false);
  assert.equal(model.showActions, false);
  assert.match(model.message, /DB에 저장/);
  assert.match(model.message, /canvas 오류/);
});

test("CANCELLED는 이미지가 있어도 취소 오버레이 상태를 반환한다", () => {
  const model = certificateViewModel({
    cert_status: "CANCELLED",
    cert_id: "CERT-3",
    certificate_path: "certificates/2026/CERT_CERT-3.png"
  });

  assert.equal(model.showPreview, true);
  assert.equal(model.showActions, false);
  assert.equal(model.cancelled, true);
  assert.match(model.message, /인증 효력이 없습니다/);
});

test("DB 저장 실패는 인증서 발행을 시도하지 않았다고 안내한다", () => {
  const model = certificateViewModel({ cert_status: "DB_SAVE_FAILED" });

  assert.equal(model.showPreview, false);
  assert.equal(model.showDetails, false);
  assert.match(model.message, /발행을 시도하지 않았습니다/);
});
