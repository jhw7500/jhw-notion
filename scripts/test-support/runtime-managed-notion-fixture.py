"""Serve deterministic Notion reads through the production protected relay."""

import sys

from runtime_managed_notion import load_notion_profile, serve_notion_relay
from runtime_managed_profile import load_profile


EXPECTED_KEY = "fixture-protected-notion-key"


def normalized(value):
    return value.replace("-", "").lower()


def fixture_upstream(notion):
    if notion.key_file.read_text(encoding="utf8").strip() != EXPECTED_KEY:
        raise RuntimeError("protected fixture key mismatch")

    def request(method, path, payload, _deadline):
        if method == "POST" and path == "/v1/search":
            if payload != {"query": "managed-relay-fixture", "page_size": 10}:
                raise RuntimeError("unexpected fixture search payload")
            return {
                "object": "list",
                "results": [{
                    "object": "page",
                    "id": "00000000-0000-4000-8000-000000000001",
                    "parent": {"type": "workspace", "workspace": True},
                    "properties": {
                        "title": {
                            "type": "title",
                            "title": [{"type": "text", "plain_text": "Managed relay fixture"}],
                        },
                    },
                    "url": "https://www.notion.so/managed-relay-fixture",
                    "last_edited_time": "2026-11-24T00:00:00.000Z",
                }],
                "next_cursor": None,
                "has_more": False,
                "type": "page_or_data_source",
                "page_or_data_source": {},
            }
        if method == "GET" and payload is None:
            prefix, separator, raw_id = path.rpartition("/")
            identifier = normalized(raw_id) if separator else ""
            for database_id, data_source_id in notion.routes:
                if prefix == "/v1/databases" and identifier == database_id:
                    return {
                        "object": "database",
                        "id": raw_id,
                        "parent": {"type": "workspace", "workspace": True},
                    }
                if prefix == "/v1/data_sources" and identifier == data_source_id:
                    return {
                        "object": "data_source",
                        "id": raw_id,
                        "parent": {"type": "database_id", "database_id": database_id},
                        "database_parent": {"type": "workspace", "workspace": True},
                    }
        raise RuntimeError("unexpected fixture request")

    return request


def main():
    if len(sys.argv) != 2:
        return 2
    profile = load_profile(sys.argv[1])
    notion = load_notion_profile(profile)
    if notion is None:
        return 2
    serve_notion_relay(profile, notion, upstream_factory=fixture_upstream)
    return 0


if __name__ == "__main__":
    sys.exit(main())
