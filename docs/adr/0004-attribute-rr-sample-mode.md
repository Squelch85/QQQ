# ADR 0004: 사진 기반 판정의 계수형 R&R 흡수

- 상태: 승인
- 날짜: 2026-06-16

## 배경

사진 기반 판정을 별도 시험으로 만들면 계수형 R&R의 기준값 대비 일치율, 반복 일치율, 1종 오류율, 2종 오류율과 중복되며 인증서 항목 오기재 위험이 커진다.

## 결정

사진 기반 판정은 독립 `image_judgment` 평가 유형으로 만들지 않는다. 모든 사진 기반 샘플 판정은 `attribute_rr`의 `sampleMode=image`로 처리한다. 실물 샘플은 `sampleMode=physical_sample`, 혼합 세트는 `sampleMode=mixed`로 관리한다.

## 결과

`image_judgment_results`, `image_judgment_trials`, 사진 판정시험 독립 합격 여부, 사진 판정시험 독립 인증 항목은 만들지 않는다. 인증서는 계수형 R&R 결과명과 산출 지표를 사용한다.
