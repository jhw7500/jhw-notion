import { randomBytes } from "node:crypto";

import { ControlError } from "./errors.js";

const slugPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;

function uuid7(now = Date.now()): string {
  const bytes = randomBytes(16);
  const milliseconds = BigInt(now);
  bytes[0] = Number((milliseconds >> 40n) & 0xffn);
  bytes[1] = Number((milliseconds >> 32n) & 0xffn);
  bytes[2] = Number((milliseconds >> 24n) & 0xffn);
  bytes[3] = Number((milliseconds >> 16n) & 0xffn);
  bytes[4] = Number((milliseconds >> 8n) & 0xffn);
  bytes[5] = Number(milliseconds & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function prefixedSlug(prefix: "prj" | "repo", slug: string): string {
  if (!slugPattern.test(slug)) {
    throw new ControlError("INVALID_SLUG", `Invalid ${prefix} slug`, { slug });
  }
  return `${prefix}-${slug}`;
}

export const newProjectId = (slug: string): string => prefixedSlug("prj", slug);

export const newRepositoryId = (slug: string): string => prefixedSlug("repo", slug);

export const newTaskId = (now?: number): string => `tsk-${uuid7(now)}`;

export const newClaimId = (now?: number): string => `clm-${uuid7(now)}`;

export const newHolderId = (now?: number): string => `hld-${uuid7(now)}`;

export const newReservationId = (now?: number): string => `rsv-${uuid7(now)}`;

export const sourceIndexKey = (nodeId: string): string => Buffer.from(nodeId, "utf8").toString("base64url");
