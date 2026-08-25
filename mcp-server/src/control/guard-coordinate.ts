import { resolve } from "node:path";

const guardHostCoordinateBrand = Symbol("guard-host-coordinate-authority");
const guardHostCoordinateValues = new WeakMap<object, string>();

/**
 * Opaque proof of one normalized host-local Guard state coordinate.
 * The normalized path remains private and this token grants no operation.
 */
export interface GuardHostCoordinateAuthority {
  readonly [guardHostCoordinateBrand]: true;
}

/** Internal constructor seam used only while capturing concrete authorities. */
export function createGuardHostCoordinateAuthority(stateDir: string): GuardHostCoordinateAuthority {
  const authority = Object.freeze({
    [guardHostCoordinateBrand]: true,
  }) as GuardHostCoordinateAuthority;
  guardHostCoordinateValues.set(authority, resolve(stateDir));
  return authority;
}

/** Compares opaque authorities without revealing their normalized paths. */
export function sameGuardHostCoordinate(
  first: GuardHostCoordinateAuthority,
  ...rest: readonly GuardHostCoordinateAuthority[]
): boolean {
  const expected = guardHostCoordinateValues.get(first);
  return expected !== undefined && rest.every((authority) =>
    guardHostCoordinateValues.get(authority) === expected);
}
