// multi_select 어휘 가드 + (opt-in) 자동 등록 공통 처리.
// note.ts(인라인)와 property-builder.ts(record/start 경유)가 동일 로직을 쓰도록 단일화.
// 분석문서: docs/03-analysis/multi-select-tag-autocreate.analysis.md §3 옵션 B
import type { Client } from "@notionhq/client";
import type { DatabaseName } from "../config.js";
import { normalizeMultiSelectValues } from "./field-vocab.js";
import { appendMultiSelectOptions } from "./api.js";

export interface MultiSelectGuardOptions {
  /** true면 미등록 값을 data source에 자동 등록 후 포함(--force-tag). 기본 false=현행 drop. */
  allowNew?: boolean;
  /** drop/자동등록 결과 경고를 누적할 배열(호출부가 응답에 노출). */
  warnings?: string[];
}

/**
 * multi_select 값을 어휘 가드(별칭 정규화+중복제거)로 거른 뒤 최종 옵션명을 반환한다.
 * - 미등록 값이 있고 `allowNew`이면 Notion data source에 자동 등록 후 포함.
 * - 자동등록 실패 시 안전하게 drop으로 폴백(저장 자체는 계속).
 * - `allowNew`가 아니면 현행대로 drop + 경고.
 */
export async function applyMultiSelectGuard(
  notion: Client,
  db: DatabaseName,
  field: string,
  rawValues: string[],
  opts: MultiSelectGuardOptions = {}
): Promise<string[]> {
  const { kept, dropped } = normalizeMultiSelectValues(db, field, rawValues);
  if (dropped.length === 0) return kept;

  if (opts.allowNew) {
    try {
      await appendMultiSelectOptions(notion, db, field, dropped);
      opts.warnings?.push(
        `[${db}.${field}] 신규 옵션 ${dropped.length}개 자동등록: ${dropped.join(", ")}`
      );
      return [...kept, ...dropped];
    } catch (e) {
      // 자동등록 실패 → drop으로 폴백(저장은 진행). 가드의 안전 우선.
      opts.warnings?.push(
        `[${db}.${field}] 자동등록 실패로 ${dropped.length}개 제외: ${dropped.join(", ")} (${(e as Error).message})`
      );
      return kept;
    }
  }

  opts.warnings?.push(
    `[${db}.${field}] 미등록 값 ${dropped.length}개 제외: ${dropped.join(", ")}`
  );
  return kept;
}
