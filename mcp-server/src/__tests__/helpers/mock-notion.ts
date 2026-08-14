import { vi } from "vitest";

// p1-3c: notion v5에서 databases.query 제거됨 → dataSources.query로 마이그레이션.
// production code는 queryDataSource wrapper 경유하여 notion.dataSources.query 호출.
// mock helper는 호환성을 위해 databases.query도 유지하지만, 실제 호출은 dataSources.query만 발생.
export interface MockNotionClient {
  search: ReturnType<typeof vi.fn>;
  databases: {
    query: ReturnType<typeof vi.fn>;
    retrieve: ReturnType<typeof vi.fn>;
  };
  dataSources: {
    query: ReturnType<typeof vi.fn>;
    retrieve: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  pages: {
    create: ReturnType<typeof vi.fn>;
    retrieve: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  blocks: {
    children: {
      list: ReturnType<typeof vi.fn>;
      append: ReturnType<typeof vi.fn>;
    };
  };
}

export function createMockNotionClient(): MockNotionClient {
  return {
    search: vi.fn(),
    databases: {
      query: vi.fn(),
      retrieve: vi.fn(),
    },
    dataSources: {
      query: vi.fn(),
      retrieve: vi.fn(),
      update: vi.fn(),
    },
    pages: {
      create: vi.fn(),
      retrieve: vi.fn(),
      update: vi.fn(),
    },
    blocks: {
      children: {
        list: vi.fn(),
        append: vi.fn(),
      },
    },
  };
}

/**
 * McpServer를 모킹하여 등록된 도구 핸들러를 캡처한다.
 * register*(server) 호출 후 capturedTools에서 핸들러를 꺼내 직접 호출할 수 있다.
 */
export interface CapturedTool {
  name: string;
  description: string;
  schema: any;
  handler: (args: any) => Promise<any>;
}

export function createMockServer(): { server: any; capturedTools: Map<string, CapturedTool> } {
  const capturedTools = new Map<string, CapturedTool>();

  const server = {
    tool: vi.fn((name: string, description: string, schema: any, handler: any) => {
      capturedTools.set(name, { name, description, schema, handler });
    }),
  };

  return { server, capturedTools };
}
