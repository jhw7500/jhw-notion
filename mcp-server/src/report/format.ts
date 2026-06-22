// 보고서 포맷팅 (P0-3).
// markdown / redmine / json 출력 지원.
import type { ReportItem } from "./query.js";

export interface ReportGroup {
  report: string;
  items: ReportItem[];
}

export interface ReportPeriod {
  start: string;
  end: string;
}

export function groupByReport(items: ReportItem[]): ReportGroup[] {
  const map = new Map<string, ReportItem[]>();
  for (const item of items) {
    const key = item.report ?? "(unmapped)";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }
  // report 카테고리 안정 정렬: 알파벳순, (unmapped)는 마지막
  return Array.from(map.entries())
    .sort(([a], [b]) => {
      if (a === "(unmapped)") return 1;
      if (b === "(unmapped)") return -1;
      return a.localeCompare(b);
    })
    .map(([report, items]) => ({ report, items }));
}

export function groupByDb(items: ReportItem[]): ReportGroup[] {
  const map = new Map<string, ReportItem[]>();
  for (const item of items) {
    if (!map.has(item.db)) map.set(item.db, []);
    map.get(item.db)!.push(item);
  }
  return Array.from(map.entries()).map(([report, items]) => ({
    report,
    items,
  }));
}

export function formatRedmine(
  groups: ReportGroup[],
  period: ReportPeriod
): string {
  const lines: string[] = [];
  lines.push(`h2. 업무 보고: ${period.start} ~ ${period.end}`);
  for (const g of groups) {
    if (g.items.length === 0) continue;
    lines.push("");
    lines.push(`h3. ${g.report}`);
    for (const item of g.items) {
      const impact = item.impact ? ` — 임팩트: ${item.impact}` : "";
      lines.push(`* ${item.date} [${item.db}] ${item.title}${impact}`);
    }
  }
  return lines.join("\n");
}

export function formatMarkdown(
  groups: ReportGroup[],
  period: ReportPeriod
): string {
  const lines: string[] = [];
  lines.push(`## 업무 보고: ${period.start} ~ ${period.end}`);
  for (const g of groups) {
    if (g.items.length === 0) continue;
    lines.push("");
    lines.push(`### ${g.report}`);
    for (const item of g.items) {
      const impact = item.impact ? ` — 임팩트: ${item.impact}` : "";
      lines.push(`- ${item.date} \`${item.db}\` ${item.title}${impact}`);
    }
  }
  return lines.join("\n");
}

export function formatJson(
  groups: ReportGroup[],
  period: ReportPeriod
): string {
  return JSON.stringify({ period, groups }, null, 2);
}
