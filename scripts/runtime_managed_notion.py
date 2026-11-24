"""Protected read-only Notion transport for one managed runtime."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import errno
import fcntl
import http.client
import json
import math
import os
from pathlib import Path
import re
import signal
import socket
import ssl
import stat
import threading
import time
from urllib.parse import urlencode

from runtime_managed_profile import _absolute_path, _root_file, trusted_directory
from runtime_managed_protocol import decode_message, encode_message
from runtime_managed_service_worker import create_sealed_artifact
from runtime_managed_transport import ManagedPeer, PeerRejected, local_socket


MAX_NOTION_RESPONSE = 8 * 1024 * 1024
NOTION_REQUEST_SECONDS = 10
NOTION_TRANSPORT_SECONDS = 12
_NOTION_VERSION = "2025-09-03"
_KEY_BYTES = 4096
_KNOWN_ERROR_CODES = frozenset((
    "invalid_json", "invalid_request_url", "invalid_request",
    "validation_error", "missing_version", "unauthorized",
    "restricted_resource", "object_not_found", "conflict_error",
    "rate_limited", "internal_server_error", "service_unavailable",
    "database_connection_unavailable", "gateway_timeout",
))
_SEARCH_PARAMETERS = frozenset(("query", "sort", "filter", "start_cursor", "page_size"))
_QUERY_PARAMETERS = frozenset((
    "filter", "sorts", "start_cursor", "page_size", "result_type",
    "archived", "in_trash", "filter_properties",
))
_CHILD_PARAMETERS = frozenset(("start_cursor", "page_size"))
_COMPACT_ID = re.compile(r"[0-9a-f]{32}", re.IGNORECASE)
_DASHED_ID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.IGNORECASE,
)


class NotionRelayRejected(RuntimeError):
    """The protected read request did not satisfy the closed relay contract."""


@dataclass(frozen=True)
class NotionProfile:
    credential_uid: int
    socket: Path
    key_file: Path
    routes: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class UpstreamResponse:
    status: int
    body: object


def _exact(value, fields):
    return type(value) is dict and set(value) == set(fields)


def _normalize_id(value):
    if (type(value) is not str
            or _COMPACT_ID.fullmatch(value) is None
            and _DASHED_ID.fullmatch(value) is None):
        raise NotionRelayRejected("invalid Notion identifier")
    return value.replace("-", "").lower()


def _formatted_id(value):
    normalized = _normalize_id(value)
    return "-".join((normalized[:8], normalized[8:12], normalized[12:16],
                     normalized[16:20], normalized[20:]))


def _bounded_json(value, depth=0):
    if depth > 16:
        raise NotionRelayRejected("request nesting is too deep")
    if value is None or type(value) is bool:
        return
    if type(value) is int:
        if not -(2**53 - 1) <= value <= 2**53 - 1:
            raise NotionRelayRejected("request number is out of range")
        return
    if type(value) is float:
        if not math.isfinite(value):
            raise NotionRelayRejected("request number is invalid")
        return
    if type(value) is str:
        if len(value) > 2048 or any(ord(character) < 32 and character not in "\t\n\r" for character in value):
            raise NotionRelayRejected("request string is invalid")
        return
    if type(value) is list:
        if len(value) > 100:
            raise NotionRelayRejected("request list is too large")
        for item in value:
            _bounded_json(item, depth + 1)
        return
    if type(value) is dict:
        if len(value) > 100:
            raise NotionRelayRejected("request object is too large")
        for name, item in value.items():
            if type(name) is not str or not name or len(name) > 128:
                raise NotionRelayRejected("request field is invalid")
            _bounded_json(item, depth + 1)
        return
    raise NotionRelayRejected("request value is invalid")


def _parameters(value, allowed):
    if type(value) is not dict or not set(value).issubset(allowed):
        raise NotionRelayRejected("unsupported Notion parameters")
    _bounded_json(value)
    page_size = value.get("page_size")
    if page_size is not None and (type(page_size) is not int or not 1 <= page_size <= 100):
        raise NotionRelayRejected("invalid page size")
    cursor = value.get("start_cursor")
    if cursor is not None and (type(cursor) is not str or not 0 < len(cursor) <= 1024):
        raise NotionRelayRejected("invalid cursor")
    return value


def _canonical_parent(value):
    if _exact(value, ("type", "workspace")) and value["type"] == "workspace" and value["workspace"] is True:
        return ("workspace",)
    if _exact(value, ("type", "page_id")) and value["type"] == "page_id":
        return ("page", _normalize_id(value["page_id"]))
    if _exact(value, ("type", "database_id")) and value["type"] == "database_id":
        return ("database", _normalize_id(value["database_id"]))
    raise NotionRelayRejected("invalid Notion parent")


def _upstream_result(upstream, method, path, payload, deadline):
    if time.monotonic() >= deadline:
        raise NotionRelayRejected("Notion read deadline exceeded")
    try:
        value = upstream(method, path, payload, deadline)
    except NotionRelayRejected:
        raise
    except Exception as error:
        raise NotionRelayRejected("Notion read unavailable") from error
    if isinstance(value, UpstreamResponse):
        status, body = value.status, value.body
    else:
        status, body = 200, value
    if type(status) is not int or type(body) is not dict:
        raise NotionRelayRejected("invalid Notion response")
    if not 400 <= status <= 599:
        if not 200 <= status <= 299:
            raise NotionRelayRejected("invalid Notion response status")
        try:
            encoded = json.dumps(body, separators=(",", ":"), allow_nan=False).encode("utf-8")
        except (TypeError, ValueError, UnicodeError) as error:
            raise NotionRelayRejected("invalid Notion response") from error
        if len(encoded) > MAX_NOTION_RESPONSE:
            raise NotionRelayRejected("Notion response exceeded the relay limit")
        return body
    code = body.get("code")
    if code not in _KNOWN_ERROR_CODES:
        code = "internal_server_error"
    return UpstreamResponse(status, {
        "object": "error",
        "status": status,
        "code": code,
        "message": "Notion request failed",
    })


def _preflight(notion, request, upstream, deadline):
    if not _exact(request, ("operation", "routes")) or request["operation"] != "preflight":
        raise NotionRelayRejected("invalid Notion preflight")
    routes = request["routes"]
    if type(routes) is not list or not routes:
        raise NotionRelayRejected("invalid Notion preflight routes")
    normalized = []
    for route in routes:
        if not _exact(route, ("databaseId", "dataSourceId")):
            raise NotionRelayRejected("invalid Notion preflight route")
        normalized.append((_normalize_id(route["databaseId"]), _normalize_id(route["dataSourceId"])))
    if len(set(normalized)) != len(normalized) or set(normalized) != set(notion.routes):
        raise NotionRelayRejected("Notion preflight routes do not match the protected profile")
    raw_by_route = {normalized_route: raw for normalized_route, raw in zip(normalized, routes, strict=True)}
    for route in notion.routes:
        raw = raw_by_route[route]
        database = _upstream_result(
            upstream, "GET", f"/v1/databases/{_formatted_id(raw['databaseId'])}", None, deadline)
        data_source = _upstream_result(
            upstream, "GET", f"/v1/data_sources/{_formatted_id(raw['dataSourceId'])}", None, deadline)
        if (isinstance(database, UpstreamResponse) or isinstance(data_source, UpstreamResponse)
                or database.get("object") != "database"
                or _normalize_id(database.get("id")) != route[0]
                or data_source.get("object") != "data_source"
                or _normalize_id(data_source.get("id")) != route[1]):
            raise NotionRelayRejected("Notion preflight identity mismatch")
        parent = data_source.get("parent")
        if (not _exact(parent, ("type", "database_id"))
                or parent["type"] != "database_id"
                or _normalize_id(parent["database_id"]) != route[0]
                or _canonical_parent(data_source.get("database_parent"))
                != _canonical_parent(database.get("parent"))):
            raise NotionRelayRejected("Notion preflight parent mismatch")
    return {"status": 200, "body": {"ok": True}}


def handle_notion_request(notion, selector, request, upstream):
    """Validate one bounded request and call only a fixed Notion read route."""
    if selector == "control":
        deadline = time.monotonic() + NOTION_REQUEST_SECONDS
        return _preflight(notion, request, upstream, deadline)
    if selector != "mcp" or type(request) is not dict:
        raise NotionRelayRejected("unsupported Notion selector")
    operation = request.get("operation")
    deadline = time.monotonic() + NOTION_REQUEST_SECONDS
    if operation == "search" and _exact(request, ("operation", "parameters")):
        method, path = "POST", "/v1/search"
        payload = _parameters(request["parameters"], _SEARCH_PARAMETERS)
    elif operation == "queryDataSource" and _exact(request, ("operation", "id", "parameters")):
        identifier = _normalize_id(request["id"])
        if identifier not in {data_source for _, data_source in notion.routes}:
            raise NotionRelayRejected("data source is outside the protected routes")
        method, path = "POST", f"/v1/data_sources/{_formatted_id(request['id'])}/query"
        parameters = _parameters(request["parameters"], _QUERY_PARAMETERS)
        filter_properties = parameters.get("filter_properties")
        if filter_properties is not None:
            if (type(filter_properties) is not list or not 0 < len(filter_properties) <= 100
                    or any(type(name) is not str or not 0 < len(name) <= 128
                           or any(ord(character) < 32 for character in name)
                           for name in filter_properties)):
                raise NotionRelayRejected("invalid filter properties")
            path += "?" + urlencode({"filter_properties": filter_properties}, doseq=True)
        payload = {name: value for name, value in parameters.items() if name != "filter_properties"}
    elif operation in ("retrievePage", "retrieveDatabase", "retrieveDataSource") and _exact(
            request, ("operation", "id")):
        _normalize_id(request["id"])
        segments = {
            "retrievePage": "pages",
            "retrieveDatabase": "databases",
            "retrieveDataSource": "data_sources",
        }
        method, path, payload = "GET", f"/v1/{segments[operation]}/{_formatted_id(request['id'])}", None
    elif operation == "listBlockChildren" and _exact(request, ("operation", "id", "parameters")):
        _normalize_id(request["id"])
        method, path = "GET", f"/v1/blocks/{_formatted_id(request['id'])}/children"
        payload = _parameters(request["parameters"], _CHILD_PARAMETERS)
    else:
        raise NotionRelayRejected("unsupported Notion operation")
    result = _upstream_result(upstream, method, path, payload, deadline)
    if isinstance(result, UpstreamResponse):
        return {"status": result.status, "body": result.body}
    return {"status": 200, "body": result}


def _read_root_profile(profile):
    path = Path(f"{profile.path}.notion.json")
    fd = _root_file(path)
    with os.fdopen(fd, "rb") as source:
        before = os.fstat(fd)
        value = decode_message(source.read(4097))
        after = os.fstat(fd)
    if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise ValueError("managed Notion profile changed during read")
    return value


def load_notion_profile(profile):
    """Load the optional root-owned credential-service coordinates."""
    try:
        value = _read_root_profile(profile)
    except FileNotFoundError:
        return None
    fields = ("version", "credentialUid", "socket", "keyFile", "routes")
    if not _exact(value, fields) or type(value["version"]) is not int or value["version"] != 1:
        raise ValueError("invalid managed Notion profile schema")
    credential_uid = value["credentialUid"]
    if (type(credential_uid) is not int or not 0 < credential_uid < 2**32 - 1
            or credential_uid in (profile.service_uid, profile.client_uid)):
        raise ValueError("managed Notion credential UID must be distinct")
    relay_socket = _absolute_path(value["socket"])
    key_file = _absolute_path(value["keyFile"])
    if (relay_socket == profile.socket or len(os.fsencode(relay_socket)) >= 108
            or relay_socket.is_relative_to(profile.repository / ".jhw-runtime")):
        raise ValueError("invalid managed Notion socket")
    if relay_socket.parent == key_file.parent:
        raise ValueError("managed Notion key and public socket require separate directories")
    raw_routes = value["routes"]
    if type(raw_routes) is not list or not raw_routes or len(raw_routes) > 32:
        raise ValueError("invalid managed Notion routes")
    try:
        routes = tuple(
            (_normalize_id(route["databaseId"]), _normalize_id(route["dataSourceId"]))
            for route in raw_routes
            if _exact(route, ("databaseId", "dataSourceId"))
        )
    except NotionRelayRejected as error:
        raise ValueError("invalid managed Notion routes") from error
    if (len(routes) != len(raw_routes) or len(set(routes)) != len(routes)
            or len({database for database, _ in routes}) != len(routes)
            or len({data_source for _, data_source in routes}) != len(routes)):
        raise ValueError("invalid managed Notion routes")
    return NotionProfile(credential_uid, relay_socket, key_file, routes)


def _read_key(notion):
    parent = trusted_directory(notion.key_file.parent, notion.credential_uid)
    try:
        fd = os.open(
            notion.key_file.name,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
            dir_fd=parent,
        )
    finally:
        os.close(parent)
    try:
        before = os.fstat(fd)
        raw = os.read(fd, _KEY_BYTES + 1)
        after = os.fstat(fd)
    finally:
        os.close(fd)
    if (not stat.S_ISREG(before.st_mode) or before.st_uid != notion.credential_uid
            or before.st_nlink != 1 or stat.S_IMODE(before.st_mode) != 0o600
            or len(raw) > _KEY_BYTES
            or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
        raise NotionRelayRejected("protected Notion credential is unavailable")
    if raw.endswith(b"\n"):
        raw = raw[:-1]
    try:
        key = raw.decode("ascii")
    except UnicodeError as error:
        raise NotionRelayRejected("protected Notion credential is unavailable") from error
    if not key or any(not 0x21 <= ord(character) <= 0x7e for character in key):
        raise NotionRelayRejected("protected Notion credential is unavailable")
    return key


def production_upstream_factory(notion):
    """Create the fixed-origin HTTPS reader inside the credential service."""
    key = _read_key(notion)
    context = ssl.create_default_context()

    def request(method, path, payload, deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise NotionRelayRejected("Notion read deadline exceeded")
        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Notion-Version": _NOTION_VERSION,
            "User-Agent": "jhw-notion-managed-relay/1",
        }
        body = None
        request_path = path
        if method == "POST":
            body = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("utf-8")
        elif payload:
            request_path = f"{path}?{urlencode(payload, doseq=True)}"
        connection = http.client.HTTPSConnection(
            "api.notion.com", 443, timeout=min(6, remaining), context=context)
        try:
            connection.request(method, request_path, body=body, headers=headers)
            response = connection.getresponse()
            chunks = []
            size = 0
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise NotionRelayRejected("Notion read deadline exceeded")
                if connection.sock is not None:
                    connection.sock.settimeout(min(6, remaining))
                chunk = response.read1(min(64 * 1024, MAX_NOTION_RESPONSE + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > MAX_NOTION_RESPONSE:
                    raise NotionRelayRejected("Notion response exceeded the relay limit")
            raw = b"".join(chunks)
            if time.monotonic() > deadline:
                raise NotionRelayRejected("Notion read deadline exceeded")
            if key.encode("ascii") in raw:
                raise NotionRelayRejected("Notion response contained protected credential material")
            try:
                decoded = json.loads(raw.decode("utf-8"))
            except (UnicodeError, json.JSONDecodeError) as error:
                raise NotionRelayRejected("invalid Notion response") from error
            return UpstreamResponse(response.status, decoded)
        finally:
            connection.close()

    return request


def read_notion_descriptor(descriptor, size, expected_uid):
    """Read a service-owned sealed response without trusting its pathname."""
    required = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
    before = os.fstat(descriptor)
    if (type(size) is not int or not 0 < size <= MAX_NOTION_RESPONSE
            or not stat.S_ISREG(before.st_mode) or before.st_uid != expected_uid
            or before.st_size != size
            or fcntl.fcntl(descriptor, fcntl.F_GET_SEALS) & required != required):
        raise NotionRelayRejected("invalid protected Notion response")
    chunks = []
    offset = 0
    while offset < size:
        chunk = os.pread(descriptor, min(64 * 1024, size - offset), offset)
        if not chunk:
            raise NotionRelayRejected("truncated protected Notion response")
        chunks.append(chunk)
        offset += len(chunk)
    after = os.fstat(descriptor)
    if ((before.st_dev, before.st_ino, before.st_uid, before.st_size, before.st_mode)
            != (after.st_dev, after.st_ino, after.st_uid, after.st_size, after.st_mode)):
        raise NotionRelayRejected("protected Notion response changed")
    return b"".join(chunks)


def send_notion_result(peer, payload):
    if type(payload) is not bytes or not 0 < len(payload) <= MAX_NOTION_RESPONSE:
        raise NotionRelayRejected("invalid protected Notion payload")
    descriptor = create_sealed_artifact(payload)
    try:
        peer.send(encode_message({"op": "notionResult", "bytes": len(payload)}), (descriptor,))
    finally:
        os.close(descriptor)


def receive_notion_result(peer, expected_uid):
    packet, descriptors = peer.receive(expected_descriptors=1)
    descriptor = descriptors[0]
    try:
        reply = decode_message(packet)
        if not _exact(reply, ("op", "bytes")) or reply["op"] != "notionResult":
            raise NotionRelayRejected("invalid protected Notion response metadata")
        return read_notion_descriptor(descriptor, reply["bytes"], expected_uid)
    finally:
        os.close(descriptor)


def request_notion_relay(profile, notion, selector, request):
    """Ask the credential service for one already session-authorized read."""
    if os.getresuid() != (profile.service_uid,) * 3 or selector not in ("mcp", "control"):
        raise NotionRelayRejected("managed Notion caller is unavailable")
    os.close(trusted_directory(notion.socket.parent, notion.credential_uid))
    connection = local_socket()
    try:
        connection.settimeout(NOTION_TRANSPORT_SECONDS)
        connection.connect(str(notion.socket))
        with ManagedPeer(connection, notion.credential_uid) as peer:
            connection = None
            peer.send(encode_message({
                "op": "notion",
                "selector": selector,
                "request": request,
            }))
            return receive_notion_result(peer, notion.credential_uid)
    except (OSError, PeerRejected, ValueError, EOFError) as error:
        raise NotionRelayRejected("managed Notion relay unavailable") from error
    finally:
        if connection is not None:
            connection.close()


def _unlink_socket(notion, parent, identity):
    try:
        info = os.stat(notion.socket.name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(info.st_mode) or (info.st_dev, info.st_ino) != identity:
        raise NotionRelayRejected("managed Notion socket identity changed")
    os.unlink(notion.socket.name, dir_fd=parent)


def _remove_closed_socket(notion, parent):
    try:
        info = os.stat(notion.socket.name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != notion.credential_uid or info.st_nlink != 1:
        raise NotionRelayRejected("invalid existing managed Notion socket")
    with local_socket() as probe:
        probe.settimeout(0.25)
        try:
            probe.connect(str(notion.socket))
        except OSError as error:
            if error.errno != errno.ECONNREFUSED:
                raise
        else:
            raise NotionRelayRejected("managed Notion socket already accepts connections")
    _unlink_socket(notion, parent, (info.st_dev, info.st_ino))


def serve_notion_relay(profile, notion, *, upstream_factory=production_upstream_factory):
    """Serve fixed Notion reads from the isolated credential UID."""
    if notion is None or os.getresuid() != (notion.credential_uid,) * 3:
        raise NotionRelayRejected("expected dedicated Notion credential UID")
    os.umask(0o077)
    parent = trusted_directory(notion.socket.parent, notion.credential_uid)
    lock = None
    identity = None
    stopping = threading.Event()
    limits = threading.BoundedSemaphore(3)
    upstream = upstream_factory(notion)

    def expire(_number, _frame):
        stopping.set()

    def handle(peer):
        try:
            with peer:
                request = decode_message(peer.receive()[0])
                if not _exact(request, ("op", "selector", "request")) or request["op"] != "notion":
                    raise NotionRelayRejected("invalid managed Notion request")
                result = handle_notion_request(
                    notion, request["selector"], request["request"], upstream)
                payload = json.dumps(
                    result, separators=(",", ":"), allow_nan=False).encode("utf-8")
                send_notion_result(peer, payload)
        except (OSError, ValueError, EOFError, PeerRejected, NotionRelayRejected):
            pass
        finally:
            limits.release()

    try:
        lock = os.open(
            "managed-notion.lock",
            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
            0o600,
            dir_fd=parent,
        )
        info = os.fstat(lock)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != notion.credential_uid
                or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600):
            raise NotionRelayRejected("invalid managed Notion service lock")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        _remove_closed_socket(notion, parent)
        with local_socket() as listener:
            listener.bind(str(notion.socket))
            info = os.stat(notion.socket.name, dir_fd=parent, follow_symlinks=False)
            identity = (info.st_dev, info.st_ino)
            os.chmod(notion.socket.name, 0o666, dir_fd=parent, follow_symlinks=False)
            listener.listen(8)
            listener.settimeout(0.25)
            for number in (signal.SIGINT, signal.SIGTERM):
                signal.signal(number, expire)
            with ThreadPoolExecutor(max_workers=3) as executor:
                while not stopping.is_set():
                    try:
                        connection, _ = listener.accept()
                    except TimeoutError:
                        continue
                    try:
                        connection.settimeout(NOTION_TRANSPORT_SECONDS)
                        peer = ManagedPeer(connection, profile.service_uid)
                    except (OSError, PeerRejected):
                        connection.close()
                        continue
                    if not limits.acquire(blocking=False):
                        peer.close()
                        continue
                    executor.submit(handle, peer)
    finally:
        try:
            if identity is not None:
                _unlink_socket(notion, parent, identity)
        finally:
            if lock is not None:
                os.close(lock)
            os.close(parent)
