import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from runtime_managed_service_worker import create_sealed_artifact
from runtime_managed_protocol import encode_message

try:
    import runtime_managed_notion as notion_relay
except ModuleNotFoundError:
    notion_relay = None


DATABASE_ID = "4430fcd4-bfba-4a46-9a1b-4520db86e883"
DATA_SOURCE_ID = "d45ed33c-26ee-45be-ad9c-513db7c422e0"


class ManagedNotionRelayTests(unittest.TestCase):
    def require_relay(self):
        self.assertIsNotNone(notion_relay, "runtime_managed_notion module is required")
        return notion_relay

    def notion_profile(self):
        relay = self.require_relay()
        return relay.NotionProfile(
            credential_uid=os.getuid(),
            socket=Path("/run/jhw-notion/relay.sock"),
            key_file=Path("/var/lib/jhw-notion/notion.key"),
            routes=((DATABASE_ID.replace("-", ""), DATA_SOURCE_ID.replace("-", "")),),
        )

    def test_mcp_allowlist_builds_only_fixed_notion_routes(self):
        relay = self.require_relay()
        calls = []

        def upstream(method, path, payload, _deadline):
            calls.append((method, path, payload))
            return {"object": "list", "results": [], "has_more": False, "next_cursor": None}

        requests = (
            ({"operation": "search", "parameters": {"query": "design", "page_size": 10}},
             ("POST", "/v1/search", {"query": "design", "page_size": 10})),
            ({"operation": "queryDataSource", "id": DATA_SOURCE_ID,
              "parameters": {
                  "filter": {"property": "status", "select": {"equals": "진행중"}},
                  "filter_properties": ["title", "status"],
              }},
             ("POST", f"/v1/data_sources/{DATA_SOURCE_ID}/query?filter_properties=title&filter_properties=status",
              {"filter": {"property": "status", "select": {"equals": "진행중"}}})),
            ({"operation": "retrievePage", "id": DATABASE_ID},
             ("GET", f"/v1/pages/{DATABASE_ID}", None)),
            ({"operation": "retrieveDatabase", "id": DATABASE_ID},
             ("GET", f"/v1/databases/{DATABASE_ID}", None)),
            ({"operation": "retrieveDataSource", "id": DATA_SOURCE_ID},
             ("GET", f"/v1/data_sources/{DATA_SOURCE_ID}", None)),
            ({"operation": "listBlockChildren", "id": DATABASE_ID,
              "parameters": {"start_cursor": "cursor", "page_size": 100}},
             ("GET", f"/v1/blocks/{DATABASE_ID}/children",
              {"start_cursor": "cursor", "page_size": 100})),
        )

        profile = self.notion_profile()
        for request, expected in requests:
            result = relay.handle_notion_request(profile, "mcp", request, upstream)
            self.assertEqual(result, {
                "status": 200,
                "body": {"object": "list", "results": [], "has_more": False, "next_cursor": None},
            })
            self.assertEqual(calls.pop(), expected)

    def test_mcp_rejects_writes_unpinned_queries_and_unknown_parameters(self):
        relay = self.require_relay()
        profile = self.notion_profile()

        def no_upstream(*_):
            self.fail("rejected requests must not reach the protected connection")

        rejected = (
            {"operation": "createPage", "parameters": {}},
            {"operation": "queryDataSource", "id": DATABASE_ID, "parameters": {}},
            {"operation": "retrievePage", "id": DATABASE_ID, "parameters": {}},
            {"operation": "search", "parameters": {"url": "https://example.invalid"}},
            {"operation": "retrievePage", "id": "4430-fcd4bfba4a469a1b4520db86e883"},
            {"operation": "listBlockChildren", "id": DATABASE_ID, "parameters": {"page_size": True}},
            {"operation": "queryDataSource", "id": DATA_SOURCE_ID,
             "parameters": {"filter_properties": [""]}},
        )
        for request in rejected:
            with self.subTest(request=request):
                with self.assertRaises(relay.NotionRelayRejected):
                    relay.handle_notion_request(profile, "mcp", request, no_upstream)

    def test_control_preflight_checks_exact_routes_and_parent_relationships(self):
        relay = self.require_relay()
        profile = self.notion_profile()
        database = {
            "object": "database",
            "id": DATABASE_ID,
            "parent": {"type": "workspace", "workspace": True},
        }
        data_source = {
            "object": "data_source",
            "id": DATA_SOURCE_ID,
            "parent": {"type": "database_id", "database_id": DATABASE_ID},
            "database_parent": {"type": "workspace", "workspace": True},
        }

        def upstream(method, path, payload, _deadline):
            self.assertEqual(method, "GET")
            self.assertIsNone(payload)
            return database if path.startswith("/v1/databases/") else data_source

        request = {"operation": "preflight", "routes": [{
            "databaseId": DATABASE_ID,
            "dataSourceId": DATA_SOURCE_ID,
        }]}
        self.assertEqual(
            relay.handle_notion_request(profile, "control", request, upstream),
            {"status": 200, "body": {"ok": True}},
        )

        changed = dict(data_source, database_parent={"type": "page_id", "page_id": DATABASE_ID})
        with self.assertRaises(relay.NotionRelayRejected):
            relay.handle_notion_request(
                profile,
                "control",
                request,
                lambda _method, path, _payload, _deadline: (
                    database if path.startswith("/v1/databases/") else changed),
            )
        with self.assertRaises(relay.NotionRelayRejected):
            relay.handle_notion_request(profile, "mcp", request, upstream)

    def test_upstream_errors_are_reduced_to_a_bounded_sdk_envelope(self):
        relay = self.require_relay()
        profile = self.notion_profile()

        result = relay.handle_notion_request(
            profile,
            "mcp",
            {"operation": "search", "parameters": {}},
            lambda *_: relay.UpstreamResponse(
                403,
                {"object": "error", "status": 403, "code": "restricted_resource",
                 "message": "secret response", "request_id": "private-id"},
            ),
        )
        self.assertEqual(result, {
            "status": 403,
            "body": {
                "object": "error",
                "status": 403,
                "code": "restricted_resource",
                "message": "Notion request failed",
            },
        })
        self.assertNotIn("secret", json.dumps(result))
        self.assertNotIn("private-id", json.dumps(result))

        long_error = relay.handle_notion_request(
            profile,
            "mcp",
            {"operation": "search", "parameters": {}},
            lambda *_: relay.UpstreamResponse(
                403,
                {"object": "error", "status": 403, "code": "restricted_resource",
                 "message": "s" * 3000},
            ),
        )
        self.assertEqual(long_error["body"]["message"], "Notion request failed")

        successful = relay.handle_notion_request(
            profile,
            "mcp",
            {"operation": "search", "parameters": {}},
            lambda *_: {"object": "list", "results": [], "long": "x" * 3000},
        )
        self.assertEqual(len(successful["body"]["long"]), 3000)

        with self.assertRaises(relay.NotionRelayRejected):
            relay.handle_notion_request(
                profile,
                "mcp",
                {"operation": "search", "parameters": {}},
                lambda *_: relay.UpstreamResponse(302, {"location": "https://example.invalid"}),
            )

    def test_load_profile_is_optional_and_rejects_ambiguous_coordinates(self):
        relay = self.require_relay()
        managed = SimpleNamespace(
            path=Path("/etc/jhw-managed.json"),
            service_uid=101,
            client_uid=102,
            socket=Path("/run/jhw-managed/runtime.sock"),
            repository=Path("/srv/jhw-managed/checkout"),
        )
        with patch.object(relay, "_read_root_profile", side_effect=FileNotFoundError()):
            self.assertIsNone(relay.load_notion_profile(managed))

        valid = {
            "version": 1,
            "credentialUid": 103,
            "socket": "/run/jhw-notion/relay.sock",
            "keyFile": "/var/lib/jhw-notion/notion.key",
            "routes": [{"databaseId": DATABASE_ID, "dataSourceId": DATA_SOURCE_ID}],
        }
        with patch.object(relay, "_read_root_profile", return_value=valid):
            loaded = relay.load_notion_profile(managed)
        self.assertEqual(loaded.credential_uid, 103)

        for changed in (
            {**valid, "credentialUid": 101},
            {**valid, "socket": "/run/jhw-managed/runtime.sock"},
            {**valid, "extra": True},
            {**valid, "routes": valid["routes"] * 2},
            {**valid, "routes": [
                valid["routes"][0],
                {"databaseId": DATABASE_ID,
                 "dataSourceId": "634f7b00-b7a2-447b-9514-a109b57557a8"},
            ]},
        ):
            with self.subTest(changed=changed):
                with patch.object(relay, "_read_root_profile", return_value=changed):
                    with self.assertRaises(ValueError):
                        relay.load_notion_profile(managed)

    def test_response_descriptor_requires_service_ownership_and_seals(self):
        relay = self.require_relay()
        descriptor = create_sealed_artifact(b'{"status":200,"body":{"ok":true}}')
        self.assertEqual(
            relay.read_notion_descriptor(descriptor, 33, os.getuid()),
            b'{"status":200,"body":{"ok":true}}',
        )
        self.assertEqual(os.fstat(descriptor).st_size, 33)
        os.close(descriptor)

        wrong_owner = create_sealed_artifact(b"x")
        with self.assertRaises(relay.NotionRelayRejected):
            relay.read_notion_descriptor(wrong_owner, 1, os.getuid() + 1)
        self.assertEqual(os.fstat(wrong_owner).st_size, 1)
        os.close(wrong_owner)

    def test_key_file_allows_one_terminal_newline_without_exporting_it(self):
        relay = self.require_relay()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.chmod(0o755)
            key = root / "notion.key"
            key.write_text("fixture-token\n", encoding="ascii")
            key.chmod(0o600)
            profile = relay.NotionProfile(
                os.getuid(), Path("/run/jhw-notion/relay.sock"), key,
                ((DATABASE_ID.replace("-", ""), DATA_SOURCE_ID.replace("-", "")),),
            )
            self.assertEqual(relay._read_key(profile), "fixture-token")

    def test_result_receiver_closes_its_single_transferred_descriptor(self):
        relay = self.require_relay()

        class Peer:
            def __init__(self, packet, descriptor):
                self.packet = packet
                self.descriptor = descriptor

            def receive(self, expected_descriptors):
                self.assert_expected = expected_descriptors
                return self.packet, (self.descriptor,)

        payload = b'{"status":200,"body":{"ok":true}}'
        descriptor = create_sealed_artifact(payload)
        peer = Peer(encode_message({"op": "notionResult", "bytes": len(payload)}), descriptor)
        self.assertEqual(relay.receive_notion_result(peer, os.getuid()), payload)
        self.assertEqual(peer.assert_expected, 1)
        with self.assertRaises(OSError):
            os.fstat(descriptor)

        malformed = create_sealed_artifact(payload)
        with self.assertRaises(relay.NotionRelayRejected):
            relay.receive_notion_result(
                Peer(encode_message({"op": "wrong", "bytes": len(payload)}), malformed),
                os.getuid(),
            )
        with self.assertRaises(OSError):
            os.fstat(malformed)


if __name__ == "__main__":
    unittest.main()
