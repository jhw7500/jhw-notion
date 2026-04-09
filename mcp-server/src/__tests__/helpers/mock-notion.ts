import { vi } from "vitest";

export interface MockNotionClient {
  search: ReturnType<typeof vi.fn>;
  databases: {
    query: ReturnType<typeof vi.fn>;
  };
  pages: {
    create: ReturnType<typeof vi.fn>;
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
    },
    pages: {
      create: vi.fn(),
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
