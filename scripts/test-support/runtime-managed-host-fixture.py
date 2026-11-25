#!/usr/bin/python3
"""Network-free gh/git fixture for managed Control preflight."""

import json
import os
from pathlib import Path
import sys


OWNER = "fixture-owner"
REPOSITORY = "fixture-owner/registry"
PROJECT_ID = "PVT_fixture"
ITEM_ID = "PVTI_fixture"
FIELD_IDS = {
    "Status": "PVTF_status",
    "Priority": "PVTF_priority",
    "Health": "PVTF_health",
    "Next Action": "PVTF_next_action",
    "Last Reviewed": "PVTF_last_reviewed",
}
OPTIONS = {
    "Status": ("proposed", "active", "paused", "completed", "cancelled"),
    "Priority": ("P0", "P1", "P2", "P3"),
    "Health": ("on-track", "at-risk", "blocked", "unknown"),
}


def output(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")


def state_path():
    return Path(os.environ["HOME"]) / ".preflight-fixture.json"


def read_state():
    return json.loads(state_path().read_text(encoding="utf8"))


def write_state(last_reviewed):
    state_path().write_text(
        json.dumps({"lastReviewed": last_reviewed}, separators=(",", ":")) + "\n",
        encoding="utf8",
    )


def draft():
    state = read_state()
    reviewed = state["lastReviewed"]
    return {
        "__typename": "ProjectV2Item",
        "id": ITEM_ID,
        "type": "DRAFT_ISSUE",
        "content": {
            "__typename": "DraftIssue",
            "id": "DI_fixture",
            "title": "[TRIAL] Project Control Preflight Fixture",
            "body": "unchanged",
        },
        "lastReviewed": (
            None if reviewed is None else {
                "__typename": "ProjectV2ItemFieldDateValue",
                "date": reviewed,
            }
        ),
    }


def fields():
    rows = []
    for name, data_type in (
        ("Status", "SINGLE_SELECT"),
        ("Priority", "SINGLE_SELECT"),
        ("Health", "SINGLE_SELECT"),
        ("Next Action", "TEXT"),
        ("Last Reviewed", "DATE"),
    ):
        row = {
            "__typename": (
                "ProjectV2SingleSelectField" if name in OPTIONS else "ProjectV2Field"
            ),
            "id": FIELD_IDS[name],
            "name": name,
            "dataType": data_type,
        }
        if name in OPTIONS:
            row["options"] = [
                {"id": f"OPT_{name.lower().replace(' ', '_')}_{index}", "name": value}
                for index, value in enumerate(OPTIONS[name], start=1)
            ]
        rows.append(row)
    return rows


def project_page():
    item = draft()
    del item["__typename"]
    item.update({
        "isArchived": False,
        "status": None,
        "priority": None,
        "health": None,
        "nextAction": None,
    })
    project_fields = fields()
    return {
        "data": {
            "user": {
                "projectV2": {
                    "id": PROJECT_ID,
                    "public": False,
                    "updatedAt": "2026-11-24T00:00:00.000Z",
                    "fields": {
                        "totalCount": len(project_fields),
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                        "nodes": project_fields,
                    },
                    "items": {
                        "totalCount": 1,
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                        "nodes": [item],
                    },
                },
            },
        },
    }


def values(arguments):
    result = {}
    for index, value in enumerate(arguments[:-1]):
        if value in ("--raw-field", "--field"):
            name, separator, content = arguments[index + 1].partition("=")
            if separator:
                result[name] = content
    return result


def gh(arguments):
    if arguments[:4] == ["api", "--include", "--silent", "/user"]:
        sys.stdout.write("HTTP/2.0 200 OK\r\nx-oauth-scopes: project\r\n\r\n{}\n")
        return 0
    if arguments[:2] == ["api", f"repos/{REPOSITORY}"]:
        output({"node_id": "R_fixture", "full_name": REPOSITORY, "private": True})
        return 0
    if f"repos/{REPOSITORY}/issues/1" in arguments:
        output({
            "node_id": "I_fixture",
            "number": 1,
            "html_url": f"https://github.com/{REPOSITORY}/issues/1",
            "title": "[TRIAL] Registry Preflight Fixture",
            "body": "unchanged",
            "labels": [{"name": "trial"}],
        })
        return 0
    if arguments[:2] != ["api", "graphql"]:
        return 2

    request = values(arguments)
    query = request.get("query", "")
    if "query ProjectPage(" in query:
        output(project_page())
        return 0
    if "query PreflightItem(" in query:
        output({"data": {"node": draft()}})
        return 0
    if "mutation SetDate(" in query:
        if request.get("projectId") != PROJECT_ID or request.get("itemId") != ITEM_ID:
            return 2
        write_state(request.get("date"))
        output({"data": {"updateProjectV2ItemFieldValue": {"projectV2Item": {"id": ITEM_ID}}}})
        return 0
    if "mutation ClearField(" in query:
        if request.get("projectId") != PROJECT_ID or request.get("itemId") != ITEM_ID:
            return 2
        write_state(None)
        output({"data": {"clearProjectV2ItemFieldValue": {"projectV2Item": {"id": ITEM_ID}}}})
        return 0
    return 2


def git(arguments):
    if arguments[:3] == ["remote", "get-url", "--all"]:
        sys.stdout.write(f"git@github.com:{REPOSITORY}.git\n")
        return 0
    if arguments[:4] == ["remote", "get-url", "--push", "--all"]:
        sys.stdout.write(f"git@github.com:{REPOSITORY}.git\n")
        return 0
    os.execv("/usr/bin/git", ["/usr/bin/git", *arguments])


def main():
    executable = Path(sys.argv[0]).name
    if executable == "gh":
        return gh(sys.argv[1:])
    if executable == "git":
        return git(sys.argv[1:])
    return 2


if __name__ == "__main__":
    sys.exit(main())
