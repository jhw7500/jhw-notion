// schema-driven Notion property builder (P1-2).
// 기존 record.ts의 if/else 분기를 schema 메타데이터 기반 generic 빌더로 교체.
// 신규 DB 추가 시 schema.ts에 항목만 추가하면 record가 자동 동작.
import type { Client } from "@notionhq/client";
import { DATABASE_SCHEMAS } from "../schema.js";
import type { DatabaseName } from "../config.js";
import { resolveProjectId } from "./resolve-project.js";
import { normalizeSelectValue } from "./field-vocab.js";
import { applyMultiSelectGuard } from "./multi-select-guard.js";

export interface BuildOptions {
  /** 자동 today fill을 켤지 (기본 true). date/start_date에 입력 없을 때 today 주입. */
  autoFillToday?: boolean;
  /** 미리 resolve된 project page ID. 있으면 resolveProject 호출 skip. */
  presetProjectId?: string;
  /**
   * multi_select 어휘 가드에서 미등록 값이 drop될 때 경고 메시지를 누적할 배열.
   * 호출부(record/note 등)가 전달하면 사용자 응답에 노출할 수 있다.
   */
  warnings?: string[];
  /** true면 미등록 multi_select 값을 drop 대신 data source에 자동 등록(--force-tag). 기본 false. */
  allowNewTags?: boolean;
}

const TODAY_FIELDS = new Set(["date", "start_date"]);

/**
 * 입력 inputs(record.ts properties 형태)를 schema에 따라 Notion API properties로 변환.
 * - schema에 없는 입력 키는 무시.
 * - select default가 정의된 필드는 입력 누락 시 default 자동.
 * - date/start_date는 autoFillToday일 때 today 자동.
 * - relation 필드(project)는 resolveProject로 ID 해석 후 [{id}].
 */
export async function buildPropertiesFromSchema(
  db: DatabaseName,
  title: string,
  inputs: Record<string, any>,
  notion: Client,
  options: BuildOptions = {}
): Promise<Record<string, any>> {
  const schema = DATABASE_SCHEMAS[db];
  if (!schema) throw new Error(`Unknown database: ${db}`);

  const props: Record<string, any> = {};
  const today = new Date().toISOString().split("T")[0];
  const autoFill = options.autoFillToday !== false;

  // title
  props[schema.title] = { title: [{ text: { content: title } }] };

  // project relation (preferences는 schema.project 미정의 — 자동 skip)
  if (schema.project && schema.project.type === "relation") {
    const raw = inputs.project;
    if (raw !== undefined && raw !== null && raw !== "") {
      const id =
        options.presetProjectId ??
        (await resolveProjectId(notion, String(raw)));
      if (id) props.project = { relation: [{ id }] };
    }
  }

  for (const [key, meta] of Object.entries(schema.properties)) {
    const raw = inputs[key];
    const missing = raw === undefined || raw === null || raw === "";

    switch (meta.type) {
      case "select": {
        const value = missing ? meta.default : String(raw);
        // 어휘 가드: 별칭 정규화 후 미허용이면 throw (vocab 없는 필드는 trim만).
        if (value) {
          props[key] = {
            select: { name: normalizeSelectValue(db, key, value) },
          };
        }
        break;
      }
      case "rich_text": {
        if (!missing) {
          props[key] = {
            rich_text: [{ text: { content: String(raw) } }],
          };
        }
        break;
      }
      case "multi_select": {
        if (!missing) {
          // 어휘 가드(별칭 정규화+중복제거) + opt-in 자동 등록.
          const names = await applyMultiSelectGuard(
            notion,
            db,
            key,
            String(raw).split(","),
            { allowNew: options.allowNewTags, warnings: options.warnings }
          );
          if (names.length > 0) {
            props[key] = {
              multi_select: names.map((name) => ({ name })),
            };
          }
        }
        break;
      }
      case "date": {
        if (!missing) {
          props[key] = { date: { start: String(raw) } };
        } else if (autoFill && TODAY_FIELDS.has(key)) {
          props[key] = { date: { start: today } };
        }
        break;
      }
      case "url": {
        if (!missing) props[key] = { url: String(raw) };
        break;
      }
      case "title":
      case "relation":
        // title/relation은 이 루프에서 처리하지 않음 (위에서 별도 처리)
        break;
    }
  }

  return props;
}
