const CERTIFICATE_STATUS_LABELS = {
  VALID: "유효",
  ISSUE_PENDING: "발행 중",
  ISSUE_FAILED: "발행 실패",
  CANCELLED: "취소",
  EXPIRED: "만료",
  LOCAL_ONLY: "로컬 발행",
  NOT_ELIGIBLE: "발행 기준 미충족",
  DB_SAVE_FAILED: "DB 저장 실패"
};

export function certificateViewModel(result = {}) {
  const status = result.cert_status || (result.cert_id ? "ISSUE_PENDING" : "NOT_ELIGIBLE");
  const hasImage = Boolean(result.certificate_path || result.previewUrl);
  const visible = status === "VALID" || status === "CANCELLED" || status === "EXPIRED" || status === "LOCAL_ONLY";
  const actionable = (status === "VALID" || status === "LOCAL_ONLY") && hasImage;
  const messages = {
    VALID: "인증서가 정상 발행되어 SQLite 결과와 함께 저장되었습니다.",
    ISSUE_PENDING: "인증서 발행 중입니다.",
    ISSUE_FAILED: `시험 결과는 DB에 저장되었지만 인증서 이미지 생성에 실패했습니다.${result.issue_error ? ` 사유: ${result.issue_error}` : ""}`,
    CANCELLED: "취소된 인증서입니다. 이미지가 표시되더라도 인증 효력이 없습니다.",
    EXPIRED: "유효기간이 만료된 인증서입니다.",
    LOCAL_ONLY: "DB 저장 없이 로컬 인증서를 발행했습니다. PNG를 보관할 수 있지만 중앙 조회·취소·감사 이력은 제공되지 않습니다.",
    NOT_ELIGIBLE: "C/D 등급 또는 불합격 결과로 인증서 발행 기준을 충족하지 못했습니다.",
    DB_SAVE_FAILED: "시험 결과 DB 저장에 실패했고 로컬 인증서 발행도 완료되지 않았습니다."
  };
  return {
    status,
    label: CERTIFICATE_STATUS_LABELS[status] || status,
    message: messages[status] || "인증서 상태를 확인할 수 없습니다.",
    showPreview: visible && hasImage,
    showDetails: Boolean(result.cert_id),
    showActions: actionable,
    loading: status === "ISSUE_PENDING",
    cancelled: status === "CANCELLED"
  };
}

export function certificateImageUrl(path) {
  if (!path) return "";
  return path.startsWith("/") ? path : `/${path}`;
}
